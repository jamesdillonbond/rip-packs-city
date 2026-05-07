// app/api/wallet-backfill-allday/route.ts
//
// AllDay wallet enricher. Per the May 6 multi-collection rollout, this
// route gets every on-chain NFT ID a wallet owns and writes the structural
// rows to wallet_moments_cache. Per-moment Cadence metadata calls are
// intentionally NOT made — the existing AllDay infra (sales-indexer +
// allday-edition-resolver) populates player_name / set_name / tier on
// the editions table; reads JOIN wallet_moments_cache.edition_key against
// editions.external_id at query time.
//
// Why no per-moment metadata?
//   - The lib/allday-cadence.GET_MOMENT_METADATA script panicked on
//     borrow for every wallet (path/interface mismatch with no working
//     replacement found in this session). Pulling N per-moment Cadence
//     calls also doesn't scale — for whales (6k+ moments) it bumps right
//     against Vercel's 300s ceiling.
//   - The proven production pattern from app/api/wallet/seed/route.ts
//     gets IDs only, and trusts the out-of-band edition resolver to fill
//     in player/set/tier on the editions table. Wallet-scoped reads JOIN
//     by edition_key.
//
// Trade-off: invitees see their moment counts on first sign-in, but
// rows that don't yet have a matching editions row will lack player /
// set names until the edition resolver catches up. For Phase 1 that's
// acceptable — the count is the most important promise.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const FLOW_REST = "https://rest-mainnet.onflow.org/v1/scripts"
const COLLECTION_SLUG = "nfl_all_day"
const ALLDAY_COLLECTION_UUID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const UPSERT_CHUNK = 200

// Same Cadence shape the wallet/seed route uses successfully (verified
// in production for all 5 collections). Note: NonFungibleToken
// `CollectionPublic` (with the Public suffix) is the capability that
// AllDay's standard collection actually exposes; the bare `Collection`
// interface in lib/allday-cadence does NOT borrow on most wallets.
const ALLDAY_GET_IDS_CADENCE = `
import NonFungibleToken from 0x1d7e57aa55817448
access(all) fun main(address: Address): [UInt64] {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(/public/AllDayNFTCollection)
  if col == nil { return [] }
  return col!.getIDs()
}
`.trim()

async function fetchOnChainIds(wallet: string): Promise<string[]> {
  const body = {
    script: btoa(ALLDAY_GET_IDS_CADENCE),
    arguments: [btoa(JSON.stringify({ type: "Address", value: wallet }))],
  }
  const res = await fetch(`${FLOW_REST}?block_height=sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    throw new Error(`Flow script HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const raw = await res.text()
  const decoded = JSON.parse(atob(raw.trim().replace(/^"|"$/g, "")))
  const arr: Array<{ value: string }> = decoded?.value ?? []
  return arr.map(v => String(v.value))
}

async function logRun(args: {
  startedAt: string
  wallet: string
  rowsFound: number
  rowsWritten: number
  rowsSkipped: number
  ok: boolean
  error?: string | null
  extra: Record<string, unknown>
}) {
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: "wallet-backfill-allday",
      p_started_at: args.startedAt,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.error ?? null,
      p_collection_slug: COLLECTION_SLUG,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: { wallet: args.wallet, ...args.extra },
    })
  } catch (err) {
    console.warn(`[wallet-backfill-allday] log_pipeline_run failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function loadCachedMomentIds(wallet: string): Promise<Set<string>> {
  const ids = new Set<string>()
  const PAGE = 1000
  let from = 0
  while (true) {
    const { data, error } = await (supabaseAdmin as any)
      .from("wallet_moments_cache")
      .select("moment_id")
      .eq("wallet_address", wallet)
      .eq("collection_id", ALLDAY_COLLECTION_UUID)
      .range(from, from + PAGE - 1)
    if (error) {
      console.warn(`[wallet-backfill-allday] cached-id read failed: ${error.message}`)
      return ids
    }
    const rows = (data ?? []) as Array<{ moment_id: string }>
    for (const r of rows) ids.add(String(r.moment_id))
    if (rows.length < PAGE) break
    from += PAGE
  }
  return ids
}

async function stampLastRefreshed(wallet: string) {
  try {
    await (supabaseAdmin as any).rpc("refresh_seeded_wallet_stats", { p_wallet_address: wallet })
  } catch { /* swallow */ }
  try {
    await (supabaseAdmin as any)
      .from("seeded_wallets")
      .update({ last_refreshed_per_collection: { [COLLECTION_SLUG]: new Date().toISOString() } })
      .eq("wallet_address", wallet)
  } catch { /* swallow */ }
}

async function runBackfill(
  startedAtIso: string,
  startedMs: number,
  wallet: string,
  skipCached: boolean
) {
  let totalUpserted = 0
  let terminatedReason: "no_more_moments" | "error" = "no_more_moments"

  try {
    const onChainIds = await fetchOnChainIds(wallet)
    if (onChainIds.length === 0) {
      await stampLastRefreshed(wallet)
      await logRun({
        startedAt: startedAtIso, wallet,
        rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: true,
        extra: {
          on_chain_count: 0, terminated_reason: "no_more_moments",
          skip_cached: skipCached, elapsed_ms: Date.now() - startedMs,
        },
      })
      return
    }

    const cachedIds = skipCached ? await loadCachedMomentIds(wallet) : new Set<string>()
    const idsToWrite = skipCached ? onChainIds.filter(id => !cachedIds.has(id)) : onChainIds
    const skippedCount = onChainIds.length - idsToWrite.length

    const now = new Date().toISOString()
    const rows = idsToWrite.map(id => ({
      wallet_address: wallet,
      collection_id: ALLDAY_COLLECTION_UUID,
      moment_id: String(id),
      // Player / set / tier intentionally null — the AllDay edition
      // resolver fills in editions.external_id metadata, and reads JOIN
      // wallet_moments_cache.edition_key → editions at query time.
      // edition_key NULL until we wire a separate post-walk enricher
      // that fetches each NFT's editionID via a batched Cadence script.
      edition_key: null,
      player_name: null,
      set_name: null,
      tier: null,
      serial_number: null,
      series_number: null,
      acquired_at: null,
      fmv_usd: null,
      last_seen_at: now,
    }))

    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      const chunk = rows.slice(i, i + UPSERT_CHUNK)
      const { data, error } = await (supabaseAdmin as any)
        .from("wallet_moments_cache")
        .upsert(chunk, { onConflict: "wallet_address,collection_id,moment_id" })
        .select("moment_id")
      if (error) {
        console.error(`[wallet-backfill-allday] upsert err chunk=${i}: ${error.message}`)
      } else {
        totalUpserted += data?.length ?? chunk.length
      }
    }

    await stampLastRefreshed(wallet)

    await logRun({
      startedAt: startedAtIso, wallet,
      rowsFound: onChainIds.length, rowsWritten: totalUpserted, rowsSkipped: skippedCount,
      ok: true,
      extra: {
        on_chain_count: onChainIds.length,
        rows_to_write: idsToWrite.length,
        skipped_cached: skippedCount,
        terminated_reason: terminatedReason,
        skip_cached: skipCached,
        elapsed_ms: Date.now() - startedMs,
      },
    })
  } catch (err) {
    terminatedReason = "error"
    const msg = err instanceof Error ? err.message : String(err)
    await logRun({
      startedAt: startedAtIso, wallet,
      rowsFound: 0, rowsWritten: totalUpserted, rowsSkipped: 0,
      ok: false, error: msg,
      extra: {
        terminated_reason: terminatedReason, skip_cached: skipCached,
        elapsed_ms: Date.now() - startedMs,
      },
    })
    console.error(`[wallet-backfill-allday] error during backfill for ${wallet}: ${msg}`)
  }
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization")
  const expectedToken = process.env.INGEST_SECRET_TOKEN
  if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { wallet?: string; skip_cached?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const wallet = body.wallet?.trim()
  if (!wallet) {
    return NextResponse.json({ error: "wallet field required" }, { status: 400 })
  }
  const skipCached = body.skip_cached !== false

  const startedMs = Date.now()
  const startedAtIso = new Date(startedMs).toISOString()

  after(async () => {
    await runBackfill(startedAtIso, startedMs, wallet, skipCached)
  })

  return NextResponse.json(
    {
      accepted: true,
      collection: COLLECTION_SLUG,
      wallet_address: wallet,
      skip_cached: skipCached,
      started_at: startedAtIso,
    },
    { status: 202 }
  )
}
