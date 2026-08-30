import { NextRequest, NextResponse, after } from "next/server"
import fcl from "@/lib/chains/flow/flow"
import * as t from "@onflow/types"
import { supabaseAdmin } from "@/lib/supabase"
import {
  isWalletAddress,
  resolveTopShotUsernameCacheAware,
} from "@/lib/chains/flow/topshot-username-resolve"
import { isStorageLimitError, isNoCollectionCapabilityError } from "@/lib/chains/flow/wallet-backfill-helpers"
// Imported from the writer module directly, not re-exported through
// wallet-backfill-helpers: this route's test suite stubs that module wholesale,
// and going through it would put the stub — not the real chunk writer — on the
// Top Shot path, which is exactly how the duplicate loop survived.
import {
  newChunkTally,
  chunkFailureError,
  chunkFailureExtra,
  upsertWmcChunkWithRetry,
} from "@/lib/chains/flow/wmc-chunk-upsert"
import { claimPipelineLockDetailed, releasePipelineLock, skippedReasonFor, walletBackfillLockKey } from "@/lib/wallet-backfill-lock"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const BATCH_SIZE = 20
const CONCURRENCY = 8
const UPSERT_CHUNK = 200
const COLLECTION_SLUG = "nba_top_shot"
const NBA_TOP_SHOT_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
// Stop the inner walk before Vercel kills the function so the upserts that
// already landed are not abandoned mid-batch and the pipeline_runs row gets
// a clean "timeout" termination_reason instead of a generic 504.
const SOFT_DEADLINE_MS = 260_000
// Defensive cap. Largest known TopShot wallet is ~70k; 200k leaves room and
// also short-circuits any pathological response. Beyond this we mark the
// run safety_ceiling and stop walking.
const MAX_MOMENTS_PER_RUN = 200_000

async function getOwnedMomentIds(wallet: string): Promise<number[]> {
  const cadence = `
    import TopShot from 0x0b2a3299cc857e29
    access(all)
    fun main(address: Address): [UInt64] {
      let acct = getAccount(address)
      let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
      if col == nil { return [] }
      return col!.getIDs()
    }
  `
  const result = await fcl.query({
    cadence,
    args: (arg: any) => [arg(wallet, t.Address)],
  })
  return Array.isArray(result) ? (result as number[]) : []
}

async function getMomentMetadata(wallet: string, id: number): Promise<Record<string, string>> {
  const cadence = `
    import TopShot from 0x0b2a3299cc857e29
    import MetadataViews from 0x1d7e57aa55817448
    access(all)
    fun main(address: Address, id: UInt64): {String:String} {
      let acct = getAccount(address)
      let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
        ?? panic("no collection")
      let nft = col.borrowMoment(id:id) ?? panic("no nft")
      let view = nft.resolveView(Type<TopShot.TopShotMomentMetadataView>()) ?? panic("no metadata")
      let data = view as! TopShot.TopShotMomentMetadataView
      return {
        "player": data.fullName ?? "",
        "team": data.teamAtMoment ?? "",
        "setName": data.setName ?? "",
        "series": data.seriesNumber?.toString() ?? "",
        "serial": data.serialNumber.toString(),
        "mint": data.numMomentsInEdition?.toString() ?? "",
        "playID": data.playID.toString(),
        "setID": data.setID.toString()
      }
    }
  `
  const result = await fcl.query({
    cadence,
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
      p_pipeline: "wallet-backfill",
      p_started_at: args.startedAt,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.error ?? null,
      p_collection_slug: "nba_top_shot",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: { wallet: args.wallet, ...args.extra },
    })
  } catch (err) {
    console.warn(
      `[wallet-backfill] log_pipeline_run failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

async function loadCachedMomentIds(wallet: string): Promise<Set<string>> {
  const ids = new Set<string>()
  const PAGE = 1000
  // Keyset paging on moment_id over the unique (wallet, collection, moment_id)
  // index — LIMIT/OFFSET re-walked the prefix on every page (O(n²) on whales).
  // Mirrors loadCachedMomentIds in lib/chains/flow/wallet-backfill-helpers.ts.
  let after: string | null = null
  while (true) {
    let q = (supabaseAdmin as any)
      .from("wallet_moments_cache")
      .select("moment_id")
      .eq("wallet_address", wallet)
      .eq("collection_id", NBA_TOP_SHOT_UUID)
    if (after != null) q = q.gt("moment_id", after)
    const { data, error } = await q.order("moment_id", { ascending: true }).limit(PAGE)
    if (error) {
      console.warn(`[wallet-backfill] cached-id read failed: ${error.message}`)
      return ids
    }
    const rows = (data ?? []) as Array<{ moment_id: string }>
    for (const r of rows) ids.add(String(r.moment_id))
    if (rows.length < PAGE) break
    after = String(rows[rows.length - 1].moment_id)
  }
  return ids
}

// How stale a wallet's cross-collection stats may get when a run changed
// nothing. Mirrors lib/chains/flow/wallet-backfill-helpers.ts.
const STATS_MAX_AGE_MS = 6 * 60 * 60 * 1000

// refresh_seeded_wallet_stats writes the legacy single-timestamp +
// cached_moment_count. The per-collection jsonb gets its top-shot slug
// bumped here so the multi-collection cron can find stale wallets per
// collection independently.
//
// `changedRows` gates the EXPENSIVE half. refresh_seeded_wallet_stats wraps
// holdings_summary(), which aggregates every collection the wallet holds — yet
// it was called at the end of each per-collection backfill, so it ran ~11x per
// wallet per day recomputing the same cross-collection number (~290 ms typical,
// ~21 s / 247 MB of reads on a 152,806-moment whale, the largest single
// consumer of DB time in pg_stat_statements).
//
// 76.6% of Top Shot backfill runs write zero rows, and a run that wrote nothing
// cannot have changed holdings. cached_fmv_usd still drifts on its own as FMV
// is repriced, so the skip is bounded by STATS_MAX_AGE_MS rather than being
// unconditional. Any run that DID write rows always refreshes immediately, so
// a real holdings change is never delayed. Full rationale — including why this
// is not a plain time debounce and not an orchestrator-level hook — is on the
// helpers copy in lib/chains/flow/wallet-backfill-helpers.ts.
async function stampLastRefreshed(wallet: string, changedRows?: number) {
  let refreshStats = true
  if (changedRows === 0) {
    try {
      const { data } = await (supabaseAdmin as any)
        .from("seeded_wallets")
        .select("last_refreshed_at")
        .eq("wallet_address", wallet)
        .limit(1)
      const raw = Array.isArray(data) ? data[0]?.last_refreshed_at : null
      const lastMs = raw ? Date.parse(String(raw)) : NaN
      // Fail-open: an unparseable/absent timestamp means "never refreshed".
      refreshStats = !Number.isFinite(lastMs) || Date.now() - lastMs > STATS_MAX_AGE_MS
    } catch {
      refreshStats = true
    }
  }
  if (refreshStats) {
    try {
      await (supabaseAdmin as any).rpc("refresh_seeded_wallet_stats", { p_wallet_address: wallet })
    } catch { /* swallow */ }
  }
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
): Promise<{ rowsFound: number }> {
  let totalFetched = 0
  let totalUpserted = 0
  let postPassUpdated = 0
  let batchesFetched = 0
  let totalSkippedCached = 0
  // wallet_moments_cache upsert-chunk failures. These used to be console.error'd
  // and then swallowed — no counter, not in rows_skipped, run still ok:true — so
  // chunk-level data loss was structurally invisible (3,497 runs reported 0
  // failures across a window that dropped ~37 chunks of up to 200 rows). Mirrors
  // lib/chains/flow/wallet-backfill-helpers.ts's ChunkFailureTally and
  // app/api/cron/ufc-enrichment-drain/route.ts's write-error surfacing.
  // Shared with lib/chains/flow/wallet-backfill-helpers.ts rather than
  // re-declared: this route had its own copy of the counters AND its own copy of
  // the bare .rpc() upsert, so the 2026-08-28 retry fix would have landed on the
  // other four collections and silently missed Top Shot. One mechanism, one set
  // of edge cases.
  const chunkTally = newChunkTally()
  let terminatedReason:
    | "no_more_moments"
    | "safety_ceiling"
    | "timeout"
    | "error" = "no_more_moments"

  // Concurrency guard (audit_20260627_pipeline_run_locks_concurrency_guard):
  // a concurrent invocation for the same wallet (cron-job.org wave overlapping
  // the GHA backstop, or an onboarding prewarm racing a cron wave) no-ops
  // instead of paying a 2nd full on-chain Cadence walk. Fail-open, except that
  // a claim refused by a SATURATED database skips this tick (see the helper).
  const lockKey = walletBackfillLockKey(COLLECTION_SLUG, wallet)
  const lockClaim = await claimPipelineLockDetailed(lockKey)
  if (!lockClaim.claimed) {
    const terminatedReason = skippedReasonFor(lockClaim)
    await logRun({
      startedAt: startedAtIso,
      wallet,
      rowsFound: 0,
      rowsWritten: 0,
      rowsSkipped: 0,
      ok: true,
      extra: {
        terminated_reason: terminatedReason,
        skip_cached: skipCached,
        elapsed_ms: Date.now() - startedMs,
      },
    })
    console.log(
      lockClaim.reason === "db_saturated"
        ? `[wallet-backfill] ${terminatedReason} wallet=${wallet} — lock claim hit a saturated database; the next cohort cycle retries`
        : `[wallet-backfill] ${terminatedReason} wallet=${wallet} — concurrent run holds the lock`,
    )
    return { rowsFound: 0 }
  }

  try {
    const onChainIds = await getOwnedMomentIds(wallet)
    if (onChainIds.length === 0) {
      await stampLastRefreshed(wallet, 0)
      await logRun({
        startedAt: startedAtIso,
        wallet,
        rowsFound: 0,
        rowsWritten: 0,
        rowsSkipped: 0,
        ok: true,
        extra: {
          on_chain_count: 0,
          pages_fetched: 0,
          total_moments_seen: 0,
          terminated_reason: "no_more_moments",
          skip_cached: skipCached,
          elapsed_ms: Date.now() - startedMs,
        },
      })
      return { rowsFound: 0 }
    }

    // THE CACHE-SKIP PATH IS AN OWNERSHIP VERIFICATION, NOT A GAP.
    //
    // onChainIds above is the wallet's COMPLETE on-chain id set. Every cached id
    // that appears in it has just been confirmed still owned; skip_cached only
    // suppresses the (expensive) metadata re-walk. Those rows are therefore
    // verified and NOT written — so wallet_moments_cache.last_seen_at does not
    // advance for them, and neither does upsert_wmc_batch's change-detect path
    // for rows whose edition_key/serial are unchanged.
    //
    // Do NOT read an old last_seen_at as "unverified". Measured 2026-07-25:
    // 2,390,895 such confirmations in 24h against ~291,192/day needed to honour a
    // 7-day promise across 2,048,775 rows (~8.2x surplus), and 250 distinct
    // wallets walked in 72h vs 246 distinct Top Shot wmc wallets — i.e. every
    // wallet every <=3 days. last_seen_at nonetheless showed 1,188,087 Top Shot
    // rows older than 30 days. That gap is the METRIC, not the pipeline: it was
    // filed as a 79%-stale crisis and retired on 2026-07-25.
    //
    // Bumping last_seen_at here would be ~2.39M UPDATEs/day on a 2.05M-row /
    // ~800MB table on the hot write path — more than a full table rewrite per day
    // in heap churn + WAL. The correct grain already exists and is already
    // written every run: wallet_backfill_state.last_scanned_at, per wallet +
    // collection (record_wallet_backfill_scan below). Read ownership freshness
    // with check_wmc_ownership_freshness() — set-returning, 0 rows = clean.
    const cachedIds = skipCached ? await loadCachedMomentIds(wallet) : new Set<string>()
    const idsToWalk = skipCached
      ? onChainIds.filter((id) => !cachedIds.has(String(id)))
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
            `[wallet-backfill] meta fail momentId=${id} wallet=${wallet.slice(0, 10)} reason=${
              err instanceof Error ? err.message : String(err)
            }`
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
        const seriesNum = meta.series ? parseInt(meta.series, 10) : null

        allRows.push({
          wallet_address: wallet,
          collection_id: NBA_TOP_SHOT_UUID,
          moment_id: String(batch[i]),
          edition_key: editionKey,
          serial_number: Number.isFinite(serial) ? serial : null,
          player_name: meta.player || null,
          set_name: meta.setName || null,
          tier: null,
          series_number: Number.isFinite(seriesNum) ? seriesNum : null,
          acquired_at: null,
          fmv_usd: null,
          last_seen_at: now,
        })
      }

      // Flush in flight whenever we cross the chunk threshold so partial
      // progress is durable even if the function is killed mid-walk.
      // Change-detecting RPC (audit_20260610_upsert_wmc_batch_change_detect):
      // skips unchanged rows (same edition_key + serial, last_seen <24h)
      // instead of a full per-row rewrite of ~1.58M rows every 6h wave.
      // totalUpserted now counts rows ACTUALLY written (insert + real update).
      if (allRows.length >= UPSERT_CHUNK) {
        const chunk = allRows.splice(0, allRows.length)
        totalUpserted += await upsertWmcChunkWithRetry(
          chunk,
          "wallet-backfill",
          chunkTally,
          `batch=${batchesFetched}`
        )
      }

      if (totalFetched > 0 && totalFetched % 200 < BATCH_SIZE) {
        console.log(
          `[wallet-backfill] progress wallet=${wallet.slice(0, 10)} fetched=${totalFetched}/${idsToWalk.length}`
        )
      }
    }

    // Flush whatever's still buffered. Same change-detecting RPC as above.
    if (allRows.length > 0) {
      totalUpserted += await upsertWmcChunkWithRetry(
        allRows,
        "wallet-backfill",
        chunkTally,
        "final"
      )
    }

    // Post-pass JOIN UPDATE: upsert_wmc_batch is authoritative only for
    // edition_key / serial_number / last_seen_at, so tier / player_name /
    // set_name are filled here NULL-only against editions (mirrors the
    // wallet-backfill-helpers details path). Without this, new TS rows would
    // wait for the platform-wide wmc-fmv-populate cron to fill metadata.
    try {
      const { data: updResult, error: updErr } = await (supabaseAdmin as any).rpc(
        "backfill_wmc_metadata_from_editions",
        { p_wallet_address: wallet, p_collection_id: NBA_TOP_SHOT_UUID }
      )
      if (updErr) {
        console.warn(`[wallet-backfill] post-pass update failed: ${updErr.message}`)
      } else if (updResult != null) {
        postPassUpdated = Number(updResult) || 0
      }
    } catch (err) {
      console.warn(
        `[wallet-backfill] post-pass update threw: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    // Refresh the seeded_wallets stats so cached_moment_count reflects the
    // new cache total + stamp last_refreshed_per_collection so the
    // multi-collection cron can find stale wallets per collection.
    await stampLastRefreshed(wallet, totalUpserted + postPassUpdated)

    await logRun({
      startedAt: startedAtIso,
      wallet,
      rowsFound: idsToWalk.length,
      rowsWritten: totalUpserted,
      // Lost chunk rows were found but never written — count them as skipped.
      rowsSkipped: totalSkippedCached + chunkTally.chunkRowsLost,
      ok: chunkTally.chunkErrors === 0,
      error: chunkFailureError(chunkTally),
      extra: {
        on_chain_count: onChainIds.length,
        pages_fetched: batchesFetched,
        total_moments_seen: totalFetched,
        skipped_cached: totalSkippedCached,
        ...chunkFailureExtra(chunkTally),
        post_pass_metadata_updated: postPassUpdated,
        terminated_reason: terminatedReason,
        skip_cached: skipCached,
        elapsed_ms: Date.now() - startedMs,
      },
    })
    return { rowsFound: onChainIds.length }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const elapsedMs = Date.now() - startedMs
    // Cadence error 1106 ("max interaction with storage") is a permanent
    // property of mega-wallets — log as ok:true with a sharded-scan flag so
    // it stops counting as a pipeline failure. See lib/wallet-backfill-helpers.
    if (isStorageLimitError(err)) {
      await logRun({
        startedAt: startedAtIso,
        wallet,
        rowsFound: totalFetched,
        rowsWritten: totalUpserted,
        rowsSkipped: totalSkippedCached,
        ok: true,
        extra: {
          pages_fetched: batchesFetched,
          total_moments_seen: totalFetched,
          terminated_reason: "storage_limit_exceeded",
          flagged_for_sharded_scan: true,
          skip_cached: skipCached,
          elapsed_ms: elapsedMs,
          error_excerpt: msg.slice(0, 200),
        },
      })
      console.log(`[wallet-backfill] wallet_too_large wallet=${wallet} — flagged for future sharded scan`)
      return { rowsFound: totalFetched }
    }
    // Wallet has no /public/MomentCollection capability — uncommon for TopShot
    // (it would mean a Flow account that has never touched TopShot at all)
    // but possible if a discovery iterator surfaces a non-collector wallet.
    // Same pattern as the AllDay reproducer 0xb6f2481eba4df97b.
    if (isNoCollectionCapabilityError(err, elapsedMs)) {
      await logRun({
        startedAt: startedAtIso,
        wallet,
        rowsFound: totalFetched,
        rowsWritten: totalUpserted,
        rowsSkipped: totalSkippedCached,
        ok: true,
        extra: {
          pages_fetched: batchesFetched,
          total_moments_seen: totalFetched,
          terminated_reason: "no_collection_capability",
          flagged_for_no_capability: true,
          skip_cached: skipCached,
          elapsed_ms: elapsedMs,
          error_excerpt: msg.slice(0, 200),
        },
      })
      console.log(`[wallet-backfill] no_collection_capability wallet=${wallet} — wallet lacks TopShot collection capability`)
      return { rowsFound: 0 }
    }
    terminatedReason = "error"
    await logRun({
      startedAt: startedAtIso,
      wallet,
      rowsFound: totalFetched,
      rowsWritten: totalUpserted,
      rowsSkipped: totalSkippedCached,
      ok: false,
      error: msg,
      extra: {
        pages_fetched: batchesFetched,
        total_moments_seen: totalFetched,
        terminated_reason: terminatedReason,
        skip_cached: skipCached,
        elapsed_ms: elapsedMs,
      },
    })
    console.error(`[wallet-backfill] error during backfill for ${wallet}: ${msg}`)
    return { rowsFound: totalFetched }
  } finally {
    await releasePipelineLock(lockKey)
  }
}

async function recordScan(wallet: string, foundCount: number) {
  try {
    await (supabaseAdmin as any).rpc("record_wallet_backfill_scan", {
      p_wallet: wallet,
      p_collection_slug: COLLECTION_SLUG,
      p_found_count: foundCount,
    })
  } catch (err) {
    console.warn(
      `[wallet-backfill] record_wallet_backfill_scan failed wallet=${wallet}: ${err instanceof Error ? err.message : String(err)}`
    )
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

  const rawInput = body.wallet?.trim()
  if (!rawInput) {
    return NextResponse.json({ error: "wallet field required" }, { status: 400 })
  }
  // skip_cached defaults true so cron-driven re-runs only enrich the diff.
  // Callers that want a forced full re-walk pass skip_cached: false.
  const skipCached = body.skip_cached !== false

  // Resolve username → 0x before kicking off Cadence. Pre-fix the route would
  // pass `jamesdillonbond` straight into the script and Flow would reject with
  // "invalid address prefix: expected 0x, got ja". Layered cache resolver
  // hits wallet_usernames first (fast) and only falls back to live TopShot
  // GQL when nothing has been seen before.
  let wallet: string
  if (isWalletAddress(rawInput)) {
    wallet = rawInput.startsWith("0x") ? rawInput : `0x${rawInput}`
  } else {
    const outcome = await resolveTopShotUsernameCacheAware(supabaseAdmin, rawInput)
    if (!outcome.found) {
      return NextResponse.json(
        { error: "could not resolve username", input: rawInput, reason: outcome.reason },
        { status: 400 }
      )
    }
    wallet = outcome.walletAddress
  }

  const startedMs = Date.now()
  const startedAtIso = new Date(startedMs).toISOString()

  // Run the heavy walk on the after() background lifetime so the caller
  // (cron-job.org / seed-wallet-refresh) gets a fast 202 even when the
  // wallet has 30k+ moments. Vercel's after() inherits maxDuration, so the
  // soft deadline above keeps the walk under that ceiling.
  after(async () => {
    const { rowsFound } = await runBackfill(startedAtIso, startedMs, wallet, skipCached)
    await recordScan(wallet, rowsFound)
  })

  return NextResponse.json(
    {
      accepted: true,
      wallet_address: wallet,
      input: rawInput,
      skip_cached: skipCached,
      started_at: startedAtIso,
    },
    { status: 202 }
  )
}
