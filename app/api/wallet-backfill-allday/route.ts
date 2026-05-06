// app/api/wallet-backfill-allday/route.ts
//
// Sibling of /api/wallet-backfill, scoped to NFL All Day. Reads on-chain
// IDs from the AllDay collection capability via Cadence, walks them in
// concurrent batches, and upserts to wallet_moments_cache with
// collection_id = AllDay UUID. Same fire-and-forget after() shape so
// cron-job.org / wallet-backfill-multicollection get a fast 202.
//
// AllDay metadata composition: borrowMomentNFT → editionID → playID →
// playData.metadata["playerFullName"|"teamName"|"playType"], setData.name,
// seriesData.name. The Cadence helper at lib/allday-cadence.ts already
// chains the joins.

import { NextRequest, NextResponse, after } from "next/server"
import fcl from "@/lib/flow"
import * as t from "@onflow/types"
import { supabaseAdmin } from "@/lib/supabase"
import { GET_OWNED_MOMENT_IDS, GET_MOMENT_METADATA } from "@/lib/allday-cadence"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const COLLECTION_SLUG = "nfl_all_day"
const ALLDAY_COLLECTION_UUID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const BATCH_SIZE = 20
const CONCURRENCY = 8
const UPSERT_CHUNK = 200
const SOFT_DEADLINE_MS = 260_000
const MAX_MOMENTS_PER_RUN = 200_000

async function getOwnedMomentIds(wallet: string): Promise<number[]> {
  const result = await fcl.query({
    cadence: GET_OWNED_MOMENT_IDS,
    args: (arg: any) => [arg(wallet, t.Address)],
  })
  return Array.isArray(result) ? (result as number[]) : []
}

async function getMomentMetadata(wallet: string, id: number): Promise<Record<string, string>> {
  const result = await fcl.query({
    cadence: GET_MOMENT_METADATA,
    args: (arg: any) => [arg(wallet, t.Address), arg(String(id), t.UInt64)],
  })
  return result as Record<string, string>
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex++
      if (currentIndex >= items.length) return
      results[currentIndex] = await worker(items[currentIndex], currentIndex)
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => runWorker())
  )
  return results
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
  // Update both the legacy single-timestamp and the per-collection jsonb so
  // mixed-shape consumers (Top Shot cron pre-Prompt-14, multi-collection
  // post-Prompt-14) keep working.
  try {
    await (supabaseAdmin as any).rpc("refresh_seeded_wallet_stats", {
      p_wallet_address: wallet,
    })
  } catch { /* swallow */ }
  try {
    await (supabaseAdmin as any)
      .from("seeded_wallets")
      .update({
        last_refreshed_per_collection: { [COLLECTION_SLUG]: new Date().toISOString() },
      })
      .eq("wallet_address", wallet)
  } catch { /* swallow */ }
}

async function runBackfill(
  startedAtIso: string,
  startedMs: number,
  wallet: string,
  skipCached: boolean
) {
  let totalFetched = 0
  let totalUpserted = 0
  let batchesFetched = 0
  let totalSkippedCached = 0
  let terminatedReason:
    | "no_more_moments"
    | "safety_ceiling"
    | "timeout"
    | "error" = "no_more_moments"

  try {
    const onChainIds = await getOwnedMomentIds(wallet)
    if (onChainIds.length === 0) {
      await stampLastRefreshed(wallet)
      await logRun({
        startedAt: startedAtIso, wallet,
        rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: true,
        extra: {
          on_chain_count: 0, pages_fetched: 0, total_moments_seen: 0,
          terminated_reason: "no_more_moments", skip_cached: skipCached,
          elapsed_ms: Date.now() - startedMs,
        },
      })
      return
    }

    const cachedIds = skipCached ? await loadCachedMomentIds(wallet) : new Set<string>()
    const idsToWalk = skipCached
      ? onChainIds.filter(id => !cachedIds.has(String(id)))
      : onChainIds
    totalSkippedCached = onChainIds.length - idsToWalk.length

    if (idsToWalk.length > MAX_MOMENTS_PER_RUN) {
      terminatedReason = "safety_ceiling"
      idsToWalk.length = MAX_MOMENTS_PER_RUN
    }

    const now = new Date().toISOString()
    const allRows: Array<Record<string, unknown>> = []

    for (let batchStart = 0; batchStart < idsToWalk.length; batchStart += BATCH_SIZE) {
      if (Date.now() - startedMs > SOFT_DEADLINE_MS) {
        terminatedReason = "timeout"
        break
      }

      const batch = idsToWalk.slice(batchStart, batchStart + BATCH_SIZE)
      batchesFetched++

      const metadataResults = await mapWithConcurrency(batch, CONCURRENCY, async (id) => {
        try {
          return await getMomentMetadata(wallet, id)
        } catch (err) {
          console.warn(
            `[wallet-backfill-allday] meta fail momentId=${id} wallet=${wallet.slice(0, 10)} reason=${err instanceof Error ? err.message : String(err)}`
          )
          return null
        }
      })

      for (let i = 0; i < batch.length; i++) {
        const meta = metadataResults[i]
        if (!meta) continue
        totalFetched++

        const setID = meta.setID ?? null
        const playID = meta.playID ?? null
        const editionKey = setID && playID ? `${setID}:${playID}` : ""
        const serial = meta.serial ? parseInt(meta.serial, 10) : null

        allRows.push({
          wallet_address: wallet,
          collection_id: ALLDAY_COLLECTION_UUID,
          moment_id: String(batch[i]),
          edition_key: editionKey,
          serial_number: Number.isFinite(serial) ? serial : null,
          player_name: meta.player || null,
          set_name: meta.setName || null,
          tier: meta.tier || null,
          series_number: null, // AllDay series is name-based, not numeric
          acquired_at: null,
          fmv_usd: null,
          last_seen_at: now,
        })
      }

      if (allRows.length >= UPSERT_CHUNK) {
        const chunk = allRows.splice(0, allRows.length)
        const { data, error } = await (supabaseAdmin as any)
          .from("wallet_moments_cache")
          .upsert(chunk, { onConflict: "wallet_address,collection_id,moment_id" })
          .select("moment_id")
        if (error) {
          console.error(`[wallet-backfill-allday] upsert err batch=${batchesFetched}: ${error.message}`)
        } else {
          totalUpserted += data?.length ?? chunk.length
        }
      }

      if (totalFetched > 0 && totalFetched % 200 < BATCH_SIZE) {
        console.log(
          `[wallet-backfill-allday] progress wallet=${wallet.slice(0, 10)} fetched=${totalFetched}/${idsToWalk.length}`
        )
      }
    }

    if (allRows.length > 0) {
      const { data, error } = await (supabaseAdmin as any)
        .from("wallet_moments_cache")
        .upsert(allRows, { onConflict: "wallet_address,collection_id,moment_id" })
        .select("moment_id")
      if (error) {
        console.error(`[wallet-backfill-allday] final upsert err: ${error.message}`)
      } else {
        totalUpserted += data?.length ?? allRows.length
      }
    }

    await stampLastRefreshed(wallet)

    await logRun({
      startedAt: startedAtIso, wallet,
      rowsFound: idsToWalk.length, rowsWritten: totalUpserted, rowsSkipped: totalSkippedCached,
      ok: true,
      extra: {
        on_chain_count: onChainIds.length,
        pages_fetched: batchesFetched,
        total_moments_seen: totalFetched,
        skipped_cached: totalSkippedCached,
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
      rowsFound: totalFetched, rowsWritten: totalUpserted, rowsSkipped: totalSkippedCached,
      ok: false, error: msg,
      extra: {
        pages_fetched: batchesFetched, total_moments_seen: totalFetched,
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
