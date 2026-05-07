// lib/wallet-backfill-helpers.ts
//
// Shared helpers for the per-collection wallet enrichers
// (wallet-backfill-allday / pinnacle / golazos / ufc / etc). Each
// collection's route is a thin wrapper that supplies a Cadence script
// and config; everything else — Flow REST call, cached-id diff, upsert,
// last-refreshed stamp, pipeline_runs logging — lives here so adding a
// new collection is a 10-line route.
//
// Note: Top Shot's wallet-backfill stays on its own implementation
// because it ALSO walks per-moment metadata via Cadence. The other four
// collections write IDs only and trust their respective edition
// resolvers to fill in player/set/tier out-of-band (same trade-off
// documented in wallet-backfill-allday — we don't have working
// per-moment metadata Cadence for those collections, but we do have
// working ID enumeration).

import { supabaseAdmin } from "@/lib/supabase"

const FLOW_REST = "https://rest-mainnet.onflow.org/v1/scripts"
const UPSERT_CHUNK = 200

export interface BackfillCollectionConfig {
  /** snake_case slug used in pipeline_runs and last_refreshed_per_collection */
  slug: string
  /** UUID of the collection in public.collections */
  collectionUuid: string
  /** Cadence script that takes Address and returns [UInt64] / [Int] of NFT ids */
  cadenceScript: string
  /** Pipeline name written to pipeline_runs.pipeline */
  pipelineName: string
}

interface BackfillArgs {
  config: BackfillCollectionConfig
  startedAtIso: string
  startedMs: number
  wallet: string
  skipCached: boolean
}

export async function fetchOnChainIds(cadence: string, wallet: string): Promise<string[]> {
  const body = {
    script: btoa(cadence),
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

// Cadence error code 1106 ("max interaction with storage exceeded the limit")
// is a permanent property of mega-wallets like 0xe1f2a091f7bb5245 (20MB+
// inventory) — there is no retry that fixes it. The script literally cannot
// touch that much state in a single transaction. These wallets need a
// future sharded-scan implementation; until then we mark them ok:true with
// terminated_reason='storage_limit_exceeded' so they stop counting as a
// pipeline failure.
export function isStorageLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return /\b1106\b/.test(msg) || /max interaction with storage/.test(msg) || /storage.*exceed/.test(msg)
}

// Wallet has no collection capability published at the /public path the
// Cadence script targets (typical reproducer: Pinnacle-only collectors
// surfaced into the AllDay queue via Flowty transactions). Flow REST returns
// HTTP 400 with `code = InvalidArgument desc = failed to ex…` (truncated
// tail not worth parsing). Distinguished from storage_limit by elapsed time:
// no_collection_capability bounces fast (~4s), storage_limit takes much
// longer. Permanent for the wallet/collection pair — no retry fixes it, the
// capability simply doesn't exist on chain.
export function isNoCollectionCapabilityError(err: unknown, elapsedMs?: number): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  const hasShape = /Flow script HTTP 400/i.test(msg) && /code\s*=\s*InvalidArgument/i.test(msg)
  if (!hasShape) return false
  if (typeof elapsedMs === "number" && elapsedMs > 10_000) return false
  return true
}

async function logRun(args: {
  pipelineName: string
  collectionSlug: string
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
    // deno-lint-ignore no-explicit-any
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: args.pipelineName,
      p_started_at: args.startedAt,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.error ?? null,
      p_collection_slug: args.collectionSlug,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: { wallet: args.wallet, ...args.extra },
    })
  } catch (err) {
    console.warn(
      `[${args.pipelineName}] log_pipeline_run failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

async function loadCachedMomentIds(wallet: string, collectionUuid: string): Promise<Set<string>> {
  const ids = new Set<string>()
  const PAGE = 1000
  let from = 0
  while (true) {
    // deno-lint-ignore no-explicit-any
    const { data, error } = await (supabaseAdmin as any)
      .from("wallet_moments_cache")
      .select("moment_id")
      .eq("wallet_address", wallet)
      .eq("collection_id", collectionUuid)
      .range(from, from + PAGE - 1)
    if (error) {
      console.warn(`[wallet-backfill] cached-id read failed: ${error.message}`)
      return ids
    }
    const rows = (data ?? []) as Array<{ moment_id: string }>
    for (const r of rows) ids.add(String(r.moment_id))
    if (rows.length < PAGE) break
    from += PAGE
  }
  return ids
}

async function stampLastRefreshed(wallet: string, slug: string) {
  try {
    // deno-lint-ignore no-explicit-any
    await (supabaseAdmin as any).rpc("refresh_seeded_wallet_stats", { p_wallet_address: wallet })
  } catch { /* swallow */ }
  try {
    // deno-lint-ignore no-explicit-any
    await (supabaseAdmin as any)
      .from("seeded_wallets")
      .update({ last_refreshed_per_collection: { [slug]: new Date().toISOString() } })
      .eq("wallet_address", wallet)
  } catch { /* swallow */ }
}

// runIdOnlyBackfill — generic background runner for non-Top-Shot
// collections. Gets on-chain IDs via the supplied Cadence script,
// upserts ID-only rows to wallet_moments_cache, and stamps
// last_refreshed_per_collection. Per-moment metadata is intentionally
// left null; out-of-band edition resolvers populate player/set/tier on
// the editions table and reads JOIN at query time.
export async function runIdOnlyBackfill(args: BackfillArgs): Promise<void> {
  const { config, startedAtIso, startedMs, wallet, skipCached } = args
  let totalUpserted = 0

  try {
    const onChainIds = await fetchOnChainIds(config.cadenceScript, wallet)
    if (onChainIds.length === 0) {
      await stampLastRefreshed(wallet, config.slug)
      await logRun({
        pipelineName: config.pipelineName,
        collectionSlug: config.slug,
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

    const cachedIds = skipCached ? await loadCachedMomentIds(wallet, config.collectionUuid) : new Set<string>()
    const idsToWrite = skipCached ? onChainIds.filter(id => !cachedIds.has(id)) : onChainIds
    const skippedCount = onChainIds.length - idsToWrite.length

    const now = new Date().toISOString()
    const rows = idsToWrite.map(id => ({
      wallet_address: wallet,
      collection_id: config.collectionUuid,
      moment_id: String(id),
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
      // deno-lint-ignore no-explicit-any
      const { data, error } = await (supabaseAdmin as any)
        .from("wallet_moments_cache")
        .upsert(chunk, { onConflict: "wallet_address,collection_id,moment_id" })
        .select("moment_id")
      if (error) {
        console.error(`[${config.pipelineName}] upsert err chunk=${i}: ${error.message}`)
      } else {
        totalUpserted += data?.length ?? chunk.length
      }
    }

    await stampLastRefreshed(wallet, config.slug)

    await logRun({
      pipelineName: config.pipelineName,
      collectionSlug: config.slug,
      startedAt: startedAtIso, wallet,
      rowsFound: onChainIds.length, rowsWritten: totalUpserted, rowsSkipped: skippedCount,
      ok: true,
      extra: {
        on_chain_count: onChainIds.length,
        rows_to_write: idsToWrite.length,
        skipped_cached: skippedCount,
        terminated_reason: "no_more_moments",
        skip_cached: skipCached,
        elapsed_ms: Date.now() - startedMs,
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const elapsedMs = Date.now() - startedMs
    if (isStorageLimitError(err)) {
      await logRun({
        pipelineName: config.pipelineName,
        collectionSlug: config.slug,
        startedAt: startedAtIso, wallet,
        rowsFound: 0, rowsWritten: totalUpserted, rowsSkipped: 0,
        ok: true,
        extra: {
          terminated_reason: "storage_limit_exceeded",
          flagged_for_sharded_scan: true,
          skip_cached: skipCached,
          elapsed_ms: elapsedMs,
          error_excerpt: msg.slice(0, 200),
        },
      })
      console.log(`[${config.pipelineName}] wallet_too_large wallet=${wallet} — flagged for future sharded scan`)
      return
    }
    if (isNoCollectionCapabilityError(err, elapsedMs)) {
      await logRun({
        pipelineName: config.pipelineName,
        collectionSlug: config.slug,
        startedAt: startedAtIso, wallet,
        rowsFound: 0, rowsWritten: totalUpserted, rowsSkipped: 0,
        ok: true,
        extra: {
          terminated_reason: "no_collection_capability",
          flagged_for_no_capability: true,
          skip_cached: skipCached,
          elapsed_ms: elapsedMs,
          error_excerpt: msg.slice(0, 200),
        },
      })
      console.log(`[${config.pipelineName}] no_collection_capability wallet=${wallet} — wallet lacks ${config.slug} collection capability`)
      return
    }
    await logRun({
      pipelineName: config.pipelineName,
      collectionSlug: config.slug,
      startedAt: startedAtIso, wallet,
      rowsFound: 0, rowsWritten: totalUpserted, rowsSkipped: 0,
      ok: false, error: msg,
      extra: {
        terminated_reason: "error", skip_cached: skipCached,
        elapsed_ms: elapsedMs,
      },
    })
    console.error(`[${config.pipelineName}] error during backfill for ${wallet}: ${msg}`)
  }
}

// ── Cadence scripts (one per supported collection) ─────────────────────

export const CADENCE_ALLDAY = `
import NonFungibleToken from 0x1d7e57aa55817448
access(all) fun main(address: Address): [UInt64] {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(/public/AllDayNFTCollection)
  if col == nil { return [] }
  return col!.getIDs()
}
`.trim()

export const CADENCE_PINNACLE = `
import NonFungibleToken from 0x1d7e57aa55817448
access(all) fun main(address: Address): [UInt64] {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(/public/PinnacleCollection)
  if col == nil { return [] }
  return col!.getIDs()
}
`.trim()

export const CADENCE_GOLAZOS = `
import NonFungibleToken from 0x1d7e57aa55817448
access(all) fun main(address: Address): [UInt64] {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(/public/GolazoNFTCollection)
  if col == nil { return [] }
  return col!.getIDs()
}
`.trim()

export const CADENCE_UFC = `
import NonFungibleToken from 0x1d7e57aa55817448
access(all) fun main(address: Address): [UInt64] {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(/public/UFC_NFTCollection)
  if col == nil { return [] }
  return col!.getIDs()
}
`.trim()

// Collection UUIDs (from public.collections; verified May 6, 2026)
export const ALLDAY_COLLECTION_UUID = "dee28451-5d62-409e-a1ad-a83f763ac070"
export const PINNACLE_COLLECTION_UUID = "7dd9dd11-e8b6-45c4-ac99-71331f959714"
export const GOLAZOS_COLLECTION_UUID = "06248cc4-b85f-47cd-af67-1855d14acd75"
export const UFC_COLLECTION_UUID = "9b4824a8-736d-4a96-b450-8dcc0c46b023"
