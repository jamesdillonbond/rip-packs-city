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

import fcl from "@/lib/chains/flow/flow"
import * as t from "@onflow/types"
import { supabaseAdmin } from "@/lib/supabase"
import {
  isWalletAddress,
  resolveTopShotUsernameCacheAware,
} from "@/lib/chains/flow/topshot-username-resolve"
import {
  GET_UNLOCKED_MOMENT_DETAILS,
  GET_UNLOCKED_MOMENT_DETAILS_RANGE,
} from "@/lib/chains/flow/allday-cadence"
import {
  GET_PINNACLE_UNLOCKED_DETAILS,
  GET_PINNACLE_UNLOCKED_DETAILS_RANGE,
} from "@/lib/chains/flow/cadence/pinnacle-wallet"
import {
  fetchAllDayStudioHoldings,
  unionHoldingTriples,
  type StudioHoldingsResult,
} from "@/lib/chains/flow/allday-studio-holdings"
import { claimPipelineLock, releasePipelineLock, walletBackfillLockKey } from "@/lib/wallet-backfill-lock"
import {
  UPSERT_CHUNK,
  newChunkTally,
  chunkFailureError,
  chunkFailureExtra,
  upsertWmcChunkWithRetry,
  CHUNK_RETRY_RUN_BUDGET_MS,
  type ChunkFailureTally,
} from "@/lib/chains/flow/wmc-chunk-upsert"

// Re-exported so existing importers of this module keep working. The
// implementation lives in wmc-chunk-upsert.ts — see the header there for why it
// is not in this file.
export {
  UPSERT_CHUNK,
  newChunkTally,
  chunkFailureError,
  chunkFailureExtra,
  upsertWmcChunkWithRetry,
  CHUNK_RETRY_RUN_BUDGET_MS,
}
export type { ChunkFailureTally }

const FLOW_REST = "https://rest-mainnet.onflow.org/v1/scripts"

// Paginated mega-wallet recovery: per-mode chunk size is the count of
// getIDs() indices walked per Cadence call. AllDay uses 1000 — borrowNFT
// + struct field reads (editionID, serialNumber) are cheap, ~10k compute
// per chunk. Pinnacle uses 500 — per-NFT MetadataViews.getTraits +
// getEditions iterates trait arrays so a 1000-NFT chunk on
// 0xb6f2481eba4df97b (1277 NFTs) tripped Cadence error 1110 itself
// (verified 2026-05-08); 500-NFT chunks fit under the 100k budget with
// margin. Soft deadline halts the chunk loop ~40s before the route's
// maxDuration=600 so the post-pass JOIN UPDATE and pipeline_runs row
// always land.
const PAGINATION_CHUNK_SIZE_BY_MODE: Record<"allday" | "pinnacle", number> = {
  allday: 1000,
  pinnacle: 500,
}
const PAGINATION_SOFT_DEADLINE_MS = 560_000

// Resolve a raw wallet input (0x-address or Top Shot username) to a 16-hex
// 0x address. Dapper SSO maps username → wallet for all 5 collections, so a
// TopShot resolution is authoritative for Pinnacle/Golazos/UFC/AllDay too.
// Without this step, Flow rejects raw usernames with HTTP 400 "Invalid Flow
// argument" in <100ms — the canonical reproducer being the seeded-wallets
// cron passing `jamesdillonbond` (username) verbatim through the
// multicollection orchestrator. Returns either a normalised 0x wallet or a
// structured error suitable for a 400 response body.
export type WalletResolution =
  | { ok: true; wallet: string }
  | { ok: false; error: string; reason?: string; input: string }

export async function resolveWalletInput(rawInput: string): Promise<WalletResolution> {
  const input = rawInput.trim()
  if (!input) return { ok: false, error: "wallet field required", input }
  if (isWalletAddress(input)) {
    return { ok: true, wallet: input.startsWith("0x") ? input : `0x${input}` }
  }
  const outcome = await resolveTopShotUsernameCacheAware(supabaseAdmin, input)
  if (!outcome.found) {
    return { ok: false, error: "could not resolve username", reason: outcome.reason, input }
  }
  return { ok: true, wallet: outcome.walletAddress }
}

export interface BackfillCollectionConfig {
  /** snake_case slug used in pipeline_runs and last_refreshed_per_collection */
  slug: string
  /** UUID of the collection in public.collections */
  collectionUuid: string
  /** Cadence script that takes Address and returns [UInt64] / [Int] of NFT ids */
  cadenceScript: string
  /** Pipeline name written to pipeline_runs.pipeline */
  pipelineName: string
  /**
   * Optional details script for runEditionSerialDetailsBackfill: takes Address
   * and returns [[nftID, editionID, serialNumber], ...]. When omitted the
   * runner falls back to the AllDay script, so AllDay's behavior is unchanged.
   */
  detailsCadence?: string
  /** pipeline_runs.extra.mode label for the details runner. */
  detailsMode?: string
  /**
   * When true, a details scan that returns ZERO on-chain moments for a wallet
   * that STILL HAS cached wmc rows for this collection is logged ok:false with
   * terminated_reason='empty_scan_but_cached_holdings' — NOT the ok:true
   * 'no_more_moments' path. This exists because a genuinely-empty wallet and a
   * failed/degraded scan (e.g. a nil capability borrow) both surface as an empty
   * array, and masking the latter as success silently stranded 3,822 Golazos
   * shells (2026-08-04). Gated per-collection (Golazos only) so AllDay's
   * verified-healthy empty behavior is untouched. See the empty-branch comment
   * in runAllDayDetailsBackfill.
   */
  flagEmptyWithCachedHoldings?: boolean
  /**
   * AllDay only. When true, the details runner ALSO walks the Dapper
   * studio-platform index for this wallet and UNIONs those moments into the
   * on-chain result (chain wins on nftId conflict).
   *
   * This is the only way to see LOCKED AllDay moments: All Day has no on-chain
   * locking contract, so a locked moment is simply absent from the holder's
   * /public/AllDayNFTCollection and getIDs() cannot return it. A wallet holding
   * only locked moments scans ok=true / rows_found=0 and reads as empty
   * (0xdcd41c74d2dd0a66, 2026-08-08 — 5 moments, 0 found).
   *
   * Fail-soft: a studio outage leaves the on-chain result untouched. Never used
   * to delete a wmc row — studio's owner_address can be stale. See
   * lib/chains/flow/allday-studio-holdings.ts.
   */
  studioCustodyHoldings?: boolean
}

interface BackfillArgs {
  config: BackfillCollectionConfig
  startedAtIso: string
  startedMs: number
  wallet: string
  skipCached: boolean
  // force=true is set by the route when the caller passes ?force=true (or
  // {force: true}). It does not change the filtering logic on its own —
  // the route already translates force=true into skipCached=false so the
  // helper writes edition_key + serial_number on every on-chain row, even
  // ones already in wmc. We thread the flag through purely for telemetry
  // (pipeline_runs.extra.force) so we can distinguish a deliberate
  // re-enrichment sweep from a normal cron pass that happened to receive
  // skip_cached=false.
  force?: boolean
  // Sync-mode checkpoint inputs. Both optional; when provided, the
  // paginated runner starts at startIndex and returns early if the
  // monotonic clock crosses softDeadlineAt. See sync-mode contract in
  // app/api/wallet-backfill-allday/route.ts.
  softDeadlineAt?: number
  startIndex?: number
}

// Shared return shape across all *DetailsBackfill helpers + the paginated
// recovery path. `complete=true` means there is no more work for this
// (wallet, collection). `nextStartIndex` is the chunk-start offset to
// resume from when complete=false; null when complete=true or when the
// helper produced no recoverable cursor (e.g. ID list never loaded).
export interface BackfillRunResult {
  rowsFound: number
  complete: boolean
  nextStartIndex: number | null
}

// fcl.query (used for the AllDay/Pinnacle DETAILS calls below) has no
// built-in timeout, unlike fetchOnChainIds' AbortSignal.timeout(20s). During
// the 2026-06-10 12:55Z connection-pool saturation, an unbounded fcl.query
// could be the await that pinned a lambda+pool slot for 600-838s on a wallet
// with only a handful of moments (elapsed_ms was uncorrelated with
// on_chain_count — the time was stall, not work). Bounding it means a stalled
// Flow access node fails fast and frees the slot rather than holding it for
// the whole route maxDuration. 35s is generous for a single-shot details
// call (normally <5s) while still well under the lambda budget.
const FLOW_QUERY_TIMEOUT_MS = 35_000

async function withFlowTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`flow_query_timeout: ${label} exceeded ${FLOW_QUERY_TIMEOUT_MS}ms`)),
      FLOW_QUERY_TIMEOUT_MS,
    )
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// A bounded fcl.query that timed out (see withFlowTimeout). Treated like the
// storage/computation-limit handlers: ok=true with a distinct
// terminated_reason so it's visible in pipeline_runs but doesn't trip a hard
// failure alert — the wallet simply re-attempts on the next cron cycle.
export function isFlowQueryTimeout(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /flow_query_timeout/.test(msg)
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

// Cadence error code 1110 ("computation exceeds limit (100000)") fires on
// mega-wallets when the script does per-NFT work (borrowNFT + getTraits +
// getEditions) and the cumulative compute crosses Flow's 100k budget. The
// canonical reproducer is 0x5f71947aea94eb43 (~7700 Pinnacle NFTs) against
// runPinnacleDetailsBackfill. Same blast radius as 1106 (storage limit) —
// retry doesn't help, the script literally can't process that much state in
// a single call. Long-term fix is pagination (slice getIDs() into chunks of
// ~1000 and chain multiple Cadence calls). Until then we mark ok=true with
// terminated_reason='computation_limit_exceeded' so the wallet stops
// counting as a pipeline failure.
export function isComputationLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return /\b1110\b/.test(msg) || /computation exceeds limit/.test(msg)
}

// AllDay's GET_UNLOCKED_MOMENT_DETAILS exhibits a different failure shape
// on mega-wallets than Pinnacle does. Instead of a clean Cadence 1110
// computation_limit_exceeded, the upstream Flow access node returns a
// generic HTTP 500 with `error=internal server error` and the script
// path (`/v1/scripts`) embedded in the message — Flow's REST/Access API
// surfacing the per-script execution-budget breach as an opaque 500.
// Canonical reproducers (May 8, 2026): 0xb7700366fa738a43 (41,550 AllDay
// moments), 0x640705263fe8f11b (43,425 AllDay moments). Treated as
// equivalent to a 1110: ok=true, flagged_for_pagination=true, log
// terminated_reason='access_api_error_likely_computation_limit'. Same
// long-term fix as Pinnacle — paginated GET_ALLDAY_DETAILS_RANGE walking
// getIDs() in ~1000-NFT chunks.
export function isAccessApiInternalServerError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /error=internal server error/i.test(msg) && /v1\/scripts/i.test(msg)
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

/**
 * Upsert `rows` to wallet_moments_cache in UPSERT_CHUNK batches via the
 * change-detecting `upsert_wmc_batch` RPC (audit_20260610_upsert_wmc_batch_change_detect:
 * skips unchanged rows — same edition_key + serial, last_seen <24h — instead of a
 * full per-row rewrite of ~1.58M rows every wave).
 *
 * Returns rows ACTUALLY written (insert + real update), not every row submitted.
 * A failing chunk does NOT abort the loop — remaining chunks still run so partial
 * progress is banked — but it IS recorded in `tally` so the caller can set
 * `ok: false` and report the loss instead of silently discarding it.
 */
async function upsertWmcChunks(
  rows: Array<Record<string, unknown>>,
  pipelineName: string,
  tally: ChunkFailureTally,
  chunkLabelPrefix = "",
): Promise<number> {
  let written = 0
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    written += await upsertWmcChunkWithRetry(
      rows.slice(i, i + UPSERT_CHUNK),
      pipelineName,
      tally,
      `${chunkLabelPrefix}${i}`,
    )
  }
  return written
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
      // Deterministic order is required to offset-page correctly: without it
      // Postgres may return a row on two pages and none, so the Set comes back
      // short. Milder here than in snapshot-institutional-wallets (2026-08-16),
      // where the same omission fabricated 161k events: this Set only decides
      // what to SKIP, so a missing id costs a redundant idempotent re-upsert
      // rather than a false record. Fix it anyway — it was ~13.5% of a large
      // wallet's rows.
      .order("moment_id", { ascending: true })
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

// Count of wmc rows this wallet already has for a collection. Used by the
// empty-scan honesty guard (flagEmptyWithCachedHoldings): a scan that returns
// ZERO on-chain moments for a wallet that STILL has cached rows is suspect —
// most likely a failed/degraded read (e.g. a nil capability borrow surfacing
// as an empty array), not a genuinely-emptied wallet — so it must NOT be logged
// as ok:true 'no_more_moments'. head:true reads the count only (no row payload
// and no 1000-row cap). Fail-open: on error, return -1 so the caller keeps the
// normal empty-wallet path rather than manufacturing a false failure.
async function countCachedRows(wallet: string, collectionUuid: string): Promise<number> {
  try {
    // deno-lint-ignore no-explicit-any
    const { count, error } = await (supabaseAdmin as any)
      .from("wallet_moments_cache")
      .select("moment_id", { count: "exact", head: true })
      .eq("wallet_address", wallet)
      .eq("collection_id", collectionUuid)
    if (error) {
      console.warn(`[wallet-backfill] cached-row count failed: ${error.message}`)
      return -1
    }
    return typeof count === "number" ? count : -1
  } catch (err) {
    console.warn(
      `[wallet-backfill] cached-row count threw: ${err instanceof Error ? err.message : String(err)}`,
    )
    return -1
  }
}

// Map<moment_id, edition_key_present>. Used by the paginated-recovery
// pre-flight short-circuit: if every on-chain ID is already cached AND
// already has edition_key populated, the chunk loop would emit dozens of
// Cadence calls (~80s wasted Cadence/cron pass on Pinnacle mega-wallets,
// per 2026-05-08 telemetry) only to skip every row at the cachedIds.has
// filter. Sharing a single map between the short-circuit check and the
// chunk loop keeps it to one wmc read.
async function loadCachedMomentIdsAndKeys(
  wallet: string,
  collectionUuid: string,
): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>()
  const PAGE = 1000
  let from = 0
  while (true) {
    // deno-lint-ignore no-explicit-any
    const { data, error } = await (supabaseAdmin as any)
      .from("wallet_moments_cache")
      .select("moment_id, edition_key")
      .eq("wallet_address", wallet)
      .eq("collection_id", collectionUuid)
      // Same reason as loadCachedMomentIds above: offset paging without a
      // deterministic order silently duplicates and drops rows.
      .order("moment_id", { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) {
      console.warn(`[wallet-backfill] cached-id-key read failed: ${error.message}`)
      return map
    }
    const rows = (data ?? []) as Array<{ moment_id: string; edition_key: string | null }>
    for (const r of rows) map.set(String(r.moment_id), r.edition_key != null)
    if (rows.length < PAGE) break
    from += PAGE
  }
  return map
}

// How stale a wallet's cross-collection stats may get when a backfill run
// changed nothing. See stampLastRefreshed for why this exists.
const STATS_MAX_AGE_MS = 6 * 60 * 60 * 1000

// stampLastRefreshed does TWO different things and they have very different
// costs. `changedRows` is the number of wmc rows this run actually wrote or
// updated; omit it (or pass a positive number) to force the full refresh.
//
//   1. refresh_seeded_wallet_stats(wallet) — EXPENSIVE and CROSS-COLLECTION.
//      It wraps holdings_summary(), which aggregates every collection the
//      wallet holds, then writes cached_moment_count / cached_fmv_usd /
//      cached_top_tier / last_refreshed_at. Measured 2026-07-26: ~290 ms on a
//      58-moment wallet but ~21 s on a 152,806-moment whale, where it reads
//      ~31,697 blocks (247 MB) at ~90% cache miss — against a 512 MB
//      shared_buffers, so one whale refresh evicts roughly half the buffer
//      pool. It was the single largest consumer of DB time in
//      pg_stat_statements.
//
//      Because it is cross-collection but was called at the end of EVERY
//      per-collection backfill, it ran ~11x per wallet per day (2,781 runs
//      across 253 wallets in 24h) recomputing the same aggregate.
//
//      The gate: 92.9% of backfill runs (2,391 of 2,573 in 24h) write ZERO
//      rows. A run that wrote nothing cannot have changed the wallet's
//      holdings, so its recompute is pure waste — EXCEPT that cached_fmv_usd
//      drifts on its own as FMV is repriced, so "nothing changed" cannot mean
//      "never refresh again". Hence: skip only when the run changed nothing
//      AND the stats are younger than STATS_MAX_AGE_MS.
//
//      This deliberately is NOT a plain time debounce and NOT a move into the
//      multicollection orchestrator. A time-only debounce is first-wins: the
//      collection that happens to finish first claims the refresh and computes
//      the aggregate before the other four have written, so a real holdings
//      change could sit invisible until the next wave. Gating on changedRows
//      keeps last-wins semantics exactly where it matters — any run that
//      actually wrote rows always refreshes immediately. And the orchestrator
//      hook does not exist: wallet-backfill-multicollection dispatches 3 of its
//      5 children fire-and-forget (only AllDay + Pinnacle are sync), so it has
//      no point at which all five are known to be done.
//
//   2. seeded_wallets.last_refreshed_per_collection[slug] — CHEAP, and the
//      freshness marker the multi-collection cron uses to find stale wallets
//      per collection. It means "we checked", not "something changed", so it is
//      written unconditionally on every call, including skipped ones.
async function stampLastRefreshed(wallet: string, slug: string, changedRows?: number) {
  let refreshStats = true
  if (changedRows === 0) {
    try {
      // deno-lint-ignore no-explicit-any
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
      // deno-lint-ignore no-explicit-any
      await (supabaseAdmin as any).rpc("refresh_seeded_wallet_stats", { p_wallet_address: wallet })
    } catch { /* swallow */ }
  }
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
export async function runIdOnlyBackfill(args: BackfillArgs): Promise<{ rowsFound: number }> {
  const { config, startedAtIso, startedMs, wallet, skipCached, force } = args
  let totalUpserted = 0
  const chunkTally = newChunkTally()

  // Concurrency guard (audit_20260627_pipeline_run_locks_concurrency_guard):
  // a concurrent invocation for the same (collection, wallet) no-ops instead
  // of paying a 2nd on-chain Cadence walk. Fail-open.
  const lockKey = walletBackfillLockKey(config.slug, wallet)
  if (!(await claimPipelineLock(lockKey))) {
    await logRun({
      pipelineName: config.pipelineName,
      collectionSlug: config.slug,
      startedAt: startedAtIso, wallet,
      rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: true,
      extra: {
        terminated_reason: "skipped_in_progress",
        skip_cached: skipCached, force: !!force,
        elapsed_ms: Date.now() - startedMs,
      },
    })
    console.log(`[${config.pipelineName}] skipped_in_progress wallet=${wallet} — concurrent run holds the lock`)
    return { rowsFound: 0 }
  }

  try {
    const onChainIds = await fetchOnChainIds(config.cadenceScript, wallet)
    if (onChainIds.length === 0) {
      await stampLastRefreshed(wallet, config.slug, 0)
      await logRun({
        pipelineName: config.pipelineName,
        collectionSlug: config.slug,
        startedAt: startedAtIso, wallet,
        rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: true,
        extra: {
          on_chain_count: 0, terminated_reason: "no_more_moments",
          skip_cached: skipCached, force: !!force, elapsed_ms: Date.now() - startedMs,
        },
      })
      return { rowsFound: 0 }
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

    totalUpserted += await upsertWmcChunks(rows, config.pipelineName, chunkTally)

    // runIdOnlyBackfill has no metadata post-pass, so upserts are the only
    // way this run can have changed the wallet's holdings.
    await stampLastRefreshed(wallet, config.slug, totalUpserted)

    await logRun({
      pipelineName: config.pipelineName,
      collectionSlug: config.slug,
      startedAt: startedAtIso, wallet,
      rowsFound: onChainIds.length,
      rowsWritten: totalUpserted,
      // Lost chunk rows were found but never written — count them as skipped.
      rowsSkipped: skippedCount + chunkTally.chunkRowsLost,
      ok: chunkTally.chunkErrors === 0,
      error: chunkFailureError(chunkTally),
      extra: {
        on_chain_count: onChainIds.length,
        rows_to_write: idsToWrite.length,
        skipped_cached: skippedCount,
        ...chunkFailureExtra(chunkTally),
        terminated_reason: "no_more_moments",
        skip_cached: skipCached,
        force: !!force,
        elapsed_ms: Date.now() - startedMs,
      },
    })
    return { rowsFound: onChainIds.length }
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
          force: !!force,
          elapsed_ms: elapsedMs,
          error_excerpt: msg.slice(0, 200),
        },
      })
      console.log(`[${config.pipelineName}] wallet_too_large wallet=${wallet} — flagged for future sharded scan`)
      return { rowsFound: 0 }
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
          force: !!force,
          elapsed_ms: elapsedMs,
          error_excerpt: msg.slice(0, 200),
        },
      })
      console.log(`[${config.pipelineName}] no_collection_capability wallet=${wallet} — wallet lacks ${config.slug} collection capability`)
      return { rowsFound: 0 }
    }
    await logRun({
      pipelineName: config.pipelineName,
      collectionSlug: config.slug,
      startedAt: startedAtIso, wallet,
      rowsFound: 0, rowsWritten: totalUpserted, rowsSkipped: 0,
      ok: false, error: msg,
      extra: {
        terminated_reason: "error", skip_cached: skipCached,
        force: !!force,
        elapsed_ms: elapsedMs,
      },
    })
    console.error(`[${config.pipelineName}] error during backfill for ${wallet}: ${msg}`)
    return { rowsFound: 0 }
  } finally {
    await releasePipelineLock(lockKey)
  }
}

// triggerUfcEnrichmentChain — fire-and-forget loop that calls
// enrich-ufc-wallet edge function with paginated start values until done.
// Called from wallet-backfill-ufc after the ID-only wmc insert lands so
// per-moment chain metadata (edition_key, player_name, set_name, tier)
// gets populated without manual intervention. Up to 30 pages × 100
// moments = 3,000 moments per wallet enriched per backfill run; any
// remaining tail drains on the next cron pass.
export async function triggerUfcEnrichmentChain(wallet: string): Promise<{
  pagesFired: number
  totalEnriched: number
  done: boolean
}> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const ingestToken = process.env.INGEST_SECRET_TOKEN
  if (!supabaseUrl || !ingestToken) {
    return { pagesFired: 0, totalEnriched: 0, done: false }
  }
  const baseUrl = `${supabaseUrl}/functions/v1/enrich-ufc-wallet`
  let start = 0
  let pages = 0
  let enrichedTotal = 0
  let done = false
  const MAX_PAGES = 30
  while (pages < MAX_PAGES) {
    const url = new URL(baseUrl)
    url.searchParams.set("wallet", wallet)
    url.searchParams.set("start", String(start))
    url.searchParams.set("token", ingestToken)
    let json: any
    try {
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${ingestToken}` },
        signal: AbortSignal.timeout(45_000),
      })
      if (!res.ok) {
        console.warn(`[ufc-enrich-chain] HTTP ${res.status} wallet=${wallet} start=${start}`)
        break
      }
      json = await res.json()
    } catch (err) {
      console.warn(`[ufc-enrich-chain] fetch failed wallet=${wallet}: ${err instanceof Error ? err.message : String(err)}`)
      break
    }
    pages++
    enrichedTotal += Number(json?.enriched ?? 0)
    if (json?.done === true || json?.nextStart == null) {
      done = true
      break
    }
    start = Number(json.nextStart)
    if (!Number.isFinite(start) || start <= 0) break
  }
  return { pagesFired: pages, totalEnriched: enrichedTotal, done }
}

// runAllDayDetailsBackfill — AllDay-specific enriched backfill. Unlike the
// generic runIdOnlyBackfill which only writes (wallet, collection, moment_id)
// tuples, this calls GET_UNLOCKED_MOMENT_DETAILS — a single Cadence script
// that returns [[nftID, editionID, serialNumber], ...] for the whole wallet
// in one shot. We write edition_key (= editionID) and serial_number on
// every row, then run a single SQL JOIN UPDATE to backfill tier /
// player_name / set_name / team_name from the editions table.
//
// Why this exists: 98.5% of wallet_moments_cache rows for AllDay had
// edition_key NULL because the prior helper wrote ID-only and there was no
// out-of-band resolver populating wmc.edition_key. The editions table has
// rich per-edition metadata (tier, player_name, set_name, team_name) but no
// path was wiring it to wmc.
export async function runAllDayDetailsBackfill(args: BackfillArgs): Promise<BackfillRunResult> {
  const { config, startedAtIso, startedMs, wallet, skipCached, force } = args
  let totalUpserted = 0
  const chunkTally = newChunkTally()
  let postPassUpdated = 0
  // Per-collection details script + telemetry label. Defaults preserve the
  // original AllDay behavior exactly for callers that don't set them.
  const detailsCadence = config.detailsCadence ?? GET_UNLOCKED_MOMENT_DETAILS
  const detailsMode = config.detailsMode ?? "details_allday"

  // Concurrency guard (audit_20260627_pipeline_run_locks_concurrency_guard):
  // claimed per sync round-trip / fire-and-forget call. A concurrent
  // invocation no-ops (returns complete=true so the orchestrator stops
  // polling this collection for this wallet). Fail-open.
  const lockKey = walletBackfillLockKey(config.slug, wallet)
  if (!(await claimPipelineLock(lockKey))) {
    await logRun({
      pipelineName: config.pipelineName,
      collectionSlug: config.slug,
      startedAt: startedAtIso, wallet,
      rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: true,
      extra: {
        terminated_reason: "skipped_in_progress",
        skip_cached: skipCached, force: !!force,
        elapsed_ms: Date.now() - startedMs,
      },
    })
    console.log(`[${config.pipelineName}] skipped_in_progress wallet=${wallet} — concurrent run holds the lock`)
    return { rowsFound: 0, complete: true, nextStartIndex: null }
  }

  // Dapper studio-platform custody walk (AllDay only). Kicked off IN PARALLEL
  // with the chain read so the extra source costs ~no additional wall-clock, and
  // so it is already in flight if the chain read falls through to the paginated
  // mega-wallet path. fetchAllDayStudioHoldings never rejects (fail-soft by
  // contract), so this promise cannot produce an unhandled rejection.
  const studioPromise: Promise<StudioHoldingsResult | null> = config.studioCustodyHoldings
    ? fetchAllDayStudioHoldings(wallet)
    : Promise.resolve(null)

  try {
    const raw = await withFlowTimeout(
      fcl.query({
        cadence: detailsCadence,
        args: (arg: any) => [arg(wallet, t.Address)],
      }),
      detailsMode,
    )
    // A SUCCESSFUL fcl.query for this script always resolves to an array
    // (possibly empty); a failed script execution REJECTS (→ the catch below).
    // So a non-array resolve is neither success nor a genuine empty wallet — it
    // is a degraded read that used to be silently coerced to [] and reported as
    // ok:true 'no_more_moments'. Surface it as a real failure instead so a
    // failed scan is never indistinguishable from an empty wallet (2026-08-04).
    if (!Array.isArray(raw)) {
      await logRun({
        pipelineName: config.pipelineName,
        collectionSlug: config.slug,
        startedAt: startedAtIso, wallet,
        rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: false,
        error: `non_array_scan_result: typeof=${typeof raw}`,
        extra: {
          terminated_reason: "non_array_scan_result",
          skip_cached: skipCached, force: !!force, elapsed_ms: Date.now() - startedMs,
          mode: detailsMode,
        },
      })
      console.warn(`[${config.pipelineName}] non_array_scan_result wallet=${wallet} typeof=${typeof raw}`)
      return { rowsFound: 0, complete: false, nextStartIndex: null }
    }
    const onChainTriples: string[][] = raw as any

    // UNION the chain result with the Dapper custody result. The chain wins on
    // nftId conflict — it is ground truth for everything it can see; studio only
    // contributes LOCKED moments the chain structurally cannot expose (All Day
    // has no on-chain locking contract, so a locked moment is simply not in the
    // holder's account). studio's owner_address can be stale, which is exactly
    // why this is a union and never a replacement, and never a delete.
    const studio = await studioPromise
    const { merged: triples, addedFromStudio } = unionHoldingTriples(
      onChainTriples,
      studio?.triples ?? [],
    )
    const studioExtra = studio
      ? {
          studio_ok: studio.ok,
          studio_count: studio.triples.length,
          studio_added: addedFromStudio,
          studio_total_count: studio.totalCount,
          studio_truncated: studio.truncated,
          ...(studio.error ? { studio_error: studio.error.slice(0, 200) } : {}),
        }
      : {}
    if (studio && !studio.ok) {
      // An incomplete custody walk must never be read as "this wallet holds no
      // locked moments" — say so in the log rather than letting a silent 0 pass.
      console.warn(
        `[${config.pipelineName}] studio_custody_walk_degraded wallet=${wallet} ` +
          `pages=${studio.pagesFetched} truncated=${studio.truncated} err=${studio.error ?? "-"}`,
      )
    }

    if (triples.length === 0) {
      // Empty-scan honesty guard (2026-08-04). A genuinely-empty wallet and a
      // failed/degraded read (e.g. a nil `capabilities.borrow`, which returns []
      // just like an empty collection) are indistinguishable from the result
      // alone. For collections that opt in (flagEmptyWithCachedHoldings — Golazos
      // only), a zero-moment scan for a wallet that STILL has cached wmc rows is
      // treated as a FAILED scan, not a clean empty: it is logged ok:false with a
      // distinct terminated_reason and the last_refreshed stamp is skipped so the
      // wallet stays stale and is re-attempted. This is what makes on_chain_count:0
      // never silently mean "the script failed" — the exact defect that stranded
      // 3,822 Golazos shells while every run logged ok:true.
      if (config.flagEmptyWithCachedHoldings) {
        const cachedCount = await countCachedRows(wallet, config.collectionUuid)
        if (cachedCount > 0) {
          await logRun({
            pipelineName: config.pipelineName,
            collectionSlug: config.slug,
            startedAt: startedAtIso, wallet,
            rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
            ok: false,
            error: `empty_scan_but_cached_holdings cached_rows=${cachedCount}`,
            extra: {
              on_chain_count: 0,
              terminated_reason: "empty_scan_but_cached_holdings",
              cached_row_count: cachedCount,
              skip_cached: skipCached, force: !!force, elapsed_ms: Date.now() - startedMs,
              mode: detailsMode,
              ...studioExtra,
            },
          })
          console.warn(
            `[${config.pipelineName}] empty_scan_but_cached_holdings wallet=${wallet} cached_rows=${cachedCount} — scan returned 0 for a wallet with cached holdings; not stamping as refreshed`,
          )
          // complete:false — the wallet still needs a successful scan.
          return { rowsFound: 0, complete: false, nextStartIndex: null }
        }
      }
      await stampLastRefreshed(wallet, config.slug, 0)
      await logRun({
        pipelineName: config.pipelineName,
        collectionSlug: config.slug,
        startedAt: startedAtIso, wallet,
        rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: true,
        extra: {
          on_chain_count: 0, terminated_reason: "no_more_moments",
          skip_cached: skipCached, force: !!force, elapsed_ms: Date.now() - startedMs,
          mode: detailsMode,
          ...studioExtra,
        },
      })
      return { rowsFound: 0, complete: true, nextStartIndex: null }
    }

    // Skip-cached must be ENRICHMENT-aware, not presence-only (2026-08-02).
    //
    // This used to load a presence-only Set via loadCachedMomentIds() and skip
    // any moment_id already in wmc. That permanently stranded every row the
    // pre-2026-07-31 ID-only writer had left with edition_key NULL: the row
    // exists, so skip_cached=true (the default from seed-wallet-refresh ->
    // wallet-backfill-multicollection) skipped it on EVERY tick, forever, and
    // only newly-acquired moments were ever enriched. Measured impact on
    // Golazos: 9,494 / 9,502 rows (99.9%, 115 wallets) sat as empty shells for
    // 3+ months AFTER the writer itself had been fixed.
    //
    // loadCachedMomentIdsAndKeys() returns Map<moment_id, edition_key_present>,
    // so we now skip only rows that are already ENRICHED and re-walk the ones
    // that still need a key. This matches what the sibling paginated runner
    // (runPaginatedDetailsBackfill) has always done.
    const cachedIds = skipCached
      ? await loadCachedMomentIdsAndKeys(wallet, config.collectionUuid)
      : new Map<string, boolean>()
    const now = new Date().toISOString()
    const rows: Array<Record<string, unknown>> = []
    let skippedCount = 0
    for (const tri of triples) {
      if (!Array.isArray(tri) || tri.length < 2) continue
      const nftId = String(tri[0])
      const editionId = String(tri[1])
      const serialRaw = tri[2] != null ? Number(tri[2]) : null
      const serial = Number.isFinite(serialRaw as number) && (serialRaw as number) > 0
        ? (serialRaw as number)
        : null
      // === true -> cached AND already has edition_key. A cached-but-unenriched
      // row is intentionally re-walked so it can be repaired.
      if (skipCached && cachedIds.get(nftId) === true) { skippedCount++; continue }
      rows.push({
        wallet_address: wallet,
        collection_id: config.collectionUuid,
        moment_id: nftId,
        edition_key: editionId,
        serial_number: serial,
        // tier/player_name/set_name filled by post-pass JOIN UPDATE below.
        tier: null,
        player_name: null,
        set_name: null,
        series_number: null,
        acquired_at: null,
        fmv_usd: null,
        last_seen_at: now,
      })
    }

    totalUpserted += await upsertWmcChunks(rows, config.pipelineName, chunkTally)

    // Post-pass JOIN UPDATE: backfill tier / player_name / set_name on rows
    // that just landed (and any older rows for this wallet/collection that
    // are still missing). The editions table is populated by separate
    // seeders; we only fill columns that are still NULL so a future
    // edition update doesn't clobber wallet-side overrides if any.
    try {
      // deno-lint-ignore no-explicit-any
      const { data: updResult, error: updErr } = await (supabaseAdmin as any).rpc(
        "backfill_wmc_metadata_from_editions",
        { p_wallet_address: wallet, p_collection_id: config.collectionUuid },
      )
      if (updErr) {
        console.warn(`[${config.pipelineName}] post-pass update failed: ${updErr.message}`)
      } else if (updResult != null) {
        postPassUpdated = Number(updResult) || 0
      }
    } catch (err) {
      console.warn(
        `[${config.pipelineName}] post-pass update threw: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    await stampLastRefreshed(wallet, config.slug, totalUpserted + postPassUpdated)
    await logRun({
      pipelineName: config.pipelineName,
      collectionSlug: config.slug,
      startedAt: startedAtIso, wallet,
      rowsFound: triples.length,
      rowsWritten: totalUpserted,
      // Lost chunk rows were found but never written — count them as skipped.
      rowsSkipped: skippedCount + chunkTally.chunkRowsLost,
      ok: chunkTally.chunkErrors === 0,
      error: chunkFailureError(chunkTally),
      extra: {
        on_chain_count: onChainTriples.length,
        holdings_count: triples.length,
        rows_to_write: rows.length,
        skipped_cached: skippedCount,
        ...studioExtra,
        ...chunkFailureExtra(chunkTally),
        post_pass_metadata_updated: postPassUpdated,
        terminated_reason: "no_more_moments",
        skip_cached: skipCached,
        force: !!force,
        elapsed_ms: Date.now() - startedMs,
        mode: detailsMode,
      },
    })
    return { rowsFound: triples.length, complete: true, nextStartIndex: null }
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
          skip_cached: skipCached, force: !!force, elapsed_ms: elapsedMs,
          error_excerpt: msg.slice(0, 200),
          mode: detailsMode,
        },
      })
      return { rowsFound: 0, complete: true, nextStartIndex: null }
    }
    if (isFlowQueryTimeout(err)) {
      await logRun({
        pipelineName: config.pipelineName,
        collectionSlug: config.slug,
        startedAt: startedAtIso, wallet,
        rowsFound: 0, rowsWritten: totalUpserted, rowsSkipped: 0,
        ok: true,
        extra: {
          terminated_reason: "flow_query_timeout",
          skip_cached: skipCached, force: !!force, elapsed_ms: elapsedMs,
          error_excerpt: msg.slice(0, 200),
          mode: detailsMode,
        },
      })
      console.log(`[${config.pipelineName}] flow_query_timeout wallet=${wallet} — freeing slot, retry next cycle`)
      return { rowsFound: 0, complete: true, nextStartIndex: null }
    }
    // Mega-wallet handlers — order matters. Check explicit Cadence 1110
    // first (rare on AllDay but cheap to detect), then the wider AllDay
    // generic-500 signature (`error=internal server error` + /v1/scripts).
    // Both fall through to the paginated recovery path which walks
    // getIDs()[start..start+1000] in chunks and stays under the 100k
    // computation budget per call. parentTerminatedReason distinguishes
    // the two trigger shapes in pipeline_runs.extra.recovered_from.
    //
    // The paginated recovery only has GET_*_DETAILS_RANGE scripts for AllDay
    // (this runner) and Pinnacle (its own runner) — there is NO Golazos range
    // script. So it MUST only run for AllDay here; routing a Golazos details
    // failure into it ran the AllDay ID/range scripts against a Golazos wallet
    // (they return nothing → pagination_failed) and burned Flow calls for
    // nothing (2026-08-04). Gate on detailsMode so AllDay's mega-wallet
    // recovery is byte-for-byte unchanged while Golazos surfaces an honest
    // failure the wallet re-attempts on the normal path next cycle.
    const canPaginate = detailsMode === "details_allday"
    if (isComputationLimitError(err)) {
      if (!canPaginate) {
        await logRun({
          pipelineName: config.pipelineName,
          collectionSlug: config.slug,
          startedAt: startedAtIso, wallet,
          rowsFound: 0, rowsWritten: totalUpserted, rowsSkipped: 0,
          ok: false, error: `computation_limit_no_paginated_path: ${msg.slice(0, 160)}`,
          extra: {
            terminated_reason: "computation_limit_no_paginated_path",
            skip_cached: skipCached, force: !!force, elapsed_ms: elapsedMs,
            mode: detailsMode,
          },
        })
        console.warn(`[${config.pipelineName}] computation_limit wallet=${wallet} — no paginated path for ${detailsMode}; not misrouting to AllDay scripts`)
        return { rowsFound: 0, complete: false, nextStartIndex: null }
      }
      console.log(`[${config.pipelineName}] computation_limit wallet=${wallet} — falling through to paginated path`)
      return await runPaginatedDetailsBackfill({
        config, startedAtIso, startedMs, wallet, skipCached, force,
        softDeadlineAt: args.softDeadlineAt, startIndex: args.startIndex,
        mode: "allday",
        parentTerminatedReason: "computation_limit_exceeded",
        parentErrorExcerpt: msg.slice(0, 200),
        // Hand the already-in-flight custody walk down so mega-wallets keep
        // their locked moments too. Written once, on the first chunk.
        studioTriples: (await studioPromise)?.triples ?? [],
      })
    }
    if (isAccessApiInternalServerError(err)) {
      if (!canPaginate) {
        await logRun({
          pipelineName: config.pipelineName,
          collectionSlug: config.slug,
          startedAt: startedAtIso, wallet,
          rowsFound: 0, rowsWritten: totalUpserted, rowsSkipped: 0,
          ok: false, error: `access_api_500_no_paginated_path: ${msg.slice(0, 160)}`,
          extra: {
            terminated_reason: "access_api_500_no_paginated_path",
            skip_cached: skipCached, force: !!force, elapsed_ms: elapsedMs,
            mode: detailsMode,
          },
        })
        console.warn(`[${config.pipelineName}] access_api_500 wallet=${wallet} — no paginated path for ${detailsMode}; not misrouting to AllDay scripts`)
        return { rowsFound: 0, complete: false, nextStartIndex: null }
      }
      console.log(`[${config.pipelineName}] access_api_500 wallet=${wallet} — falling through to paginated path`)
      return await runPaginatedDetailsBackfill({
        config, startedAtIso, startedMs, wallet, skipCached, force,
        softDeadlineAt: args.softDeadlineAt, startIndex: args.startIndex,
        mode: "allday",
        parentTerminatedReason: "access_api_error_likely_computation_limit",
        parentErrorExcerpt: msg.slice(0, 200),
        studioTriples: (await studioPromise)?.triples ?? [],
      })
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
          skip_cached: skipCached, force: !!force, elapsed_ms: elapsedMs,
          error_excerpt: msg.slice(0, 200),
          mode: detailsMode,
        },
      })
      return { rowsFound: 0, complete: true, nextStartIndex: null }
    }
    await logRun({
      pipelineName: config.pipelineName,
      collectionSlug: config.slug,
      startedAt: startedAtIso, wallet,
      rowsFound: 0, rowsWritten: totalUpserted, rowsSkipped: 0,
      ok: false, error: msg,
      extra: {
        terminated_reason: "error", skip_cached: skipCached,
        force: !!force,
        elapsed_ms: elapsedMs, mode: detailsMode,
      },
    })
    console.error(`[${config.pipelineName}] error during details backfill for ${wallet}: ${msg}`)
    return { rowsFound: 0, complete: true, nextStartIndex: null }
  } finally {
    await releasePipelineLock(lockKey)
  }
}

// runPinnacleDetailsBackfill — Pinnacle-specific enriched backfill. Mirrors
// runAllDayDetailsBackfill: a single Cadence call returns
// [{id, editionKey, serial}, ...] for the wallet, we upsert with edition_key
// + serial_number populated, then a Pinnacle-specific JOIN UPDATE backfills
// character_name / set_name / tier (= variant_type) / mint_count from the
// pinnacle_editions table.
//
// Why this exists (parallel to AllDay rationale): the pinnacle-nft-resolver
// only catches NFTs that fired recent on-chain Deposit events, so stable
// holdings (Trevor's 180 Pinnacle moments — only 1 mapped) were invisible
// to the resolver. Write-time enrichment closes that gap.
export async function runPinnacleDetailsBackfill(args: BackfillArgs): Promise<BackfillRunResult> {
  const { config, startedAtIso, startedMs, wallet, skipCached, force } = args
  let totalUpserted = 0
  const chunkTally = newChunkTally()
  let postPassUpdated = 0

  // Concurrency guard (audit_20260627_pipeline_run_locks_concurrency_guard):
  // claimed per sync round-trip / fire-and-forget call. A concurrent
  // invocation no-ops (returns complete=true so the orchestrator stops
  // polling this collection for this wallet). Fail-open.
  const lockKey = walletBackfillLockKey(config.slug, wallet)
  if (!(await claimPipelineLock(lockKey))) {
    await logRun({
      pipelineName: config.pipelineName,
      collectionSlug: config.slug,
      startedAt: startedAtIso, wallet,
      rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: true,
      extra: {
        terminated_reason: "skipped_in_progress",
        skip_cached: skipCached, force: !!force,
        elapsed_ms: Date.now() - startedMs,
      },
    })
    console.log(`[${config.pipelineName}] skipped_in_progress wallet=${wallet} — concurrent run holds the lock`)
    return { rowsFound: 0, complete: true, nextStartIndex: null }
  }

  try {
    const raw = await withFlowTimeout(
      fcl.query({
        cadence: GET_PINNACLE_UNLOCKED_DETAILS,
        args: (arg: any) => [arg(wallet, t.Address)],
      }),
      "GET_PINNACLE_UNLOCKED_DETAILS",
    )
    type PinDetail = { id: string; editionKey: string | null; serial: string | null }
    const details: PinDetail[] = Array.isArray(raw) ? (raw as any) : []

    if (details.length === 0) {
      await stampLastRefreshed(wallet, config.slug, 0)
      await logRun({
        pipelineName: config.pipelineName,
        collectionSlug: config.slug,
        startedAt: startedAtIso, wallet,
        rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: true,
        extra: {
          on_chain_count: 0, terminated_reason: "no_more_moments",
          skip_cached: skipCached, force: !!force, elapsed_ms: Date.now() - startedMs,
          mode: "details_pinnacle",
        },
      })
      return { rowsFound: 0, complete: true, nextStartIndex: null }
    }

    // Enrichment-aware skip — same fix as runAllDayDetailsBackfill above
    // (2026-08-02). A presence-only Set permanently strands any row an
    // earlier ID-only writer left with edition_key NULL, because skip_cached
    // defaults to true on the cron path. Not currently biting Pinnacle
    // (only 197 of 50,970 rows lack a key, since the paginated runner already
    // used the enrichment-aware map for the big wallets) but it is the same
    // latent defect, so it is closed here too rather than left as a trap.
    const cachedIds = skipCached
      ? await loadCachedMomentIdsAndKeys(wallet, config.collectionUuid)
      : new Map<string, boolean>()
    const now = new Date().toISOString()
    const rows: Array<Record<string, unknown>> = []
    let skippedCount = 0
    for (const d of details) {
      const nftId = String(d.id)
      const editionKey = d.editionKey != null ? String(d.editionKey) : null
      const serialRaw = d.serial != null ? Number(d.serial) : null
      const serial = Number.isFinite(serialRaw as number) && (serialRaw as number) > 0
        ? (serialRaw as number)
        : null
      // === true -> cached AND already keyed. Note serial_number is NOT part
      // of this test: Pinnacle Open / Open Event / Starter editions carry no
      // on-chain serial at all (MetadataViews.Edition.number is only set for
      // Limited / Limited Event / Legendary / Genesis), so a NULL serial is
      // an honest upstream gap and must not force an endless re-walk.
      if (skipCached && cachedIds.get(nftId) === true) { skippedCount++; continue }
      rows.push({
        wallet_address: wallet,
        collection_id: config.collectionUuid,
        moment_id: nftId,
        edition_key: editionKey,
        serial_number: serial,
        // character_name/set_name/tier/mint_count filled by post-pass JOIN.
        character_name: null,
        set_name: null,
        tier: null,
        player_name: null,
        series_number: null,
        acquired_at: null,
        fmv_usd: null,
        last_seen_at: now,
      })
    }

    totalUpserted += await upsertWmcChunks(rows, config.pipelineName, chunkTally)

    // Post-pass JOIN UPDATE against pinnacle_editions.
    try {
      // deno-lint-ignore no-explicit-any
      const { data: updResult, error: updErr } = await (supabaseAdmin as any).rpc(
        "backfill_pinnacle_wmc_metadata_from_editions",
        { p_wallet_address: wallet },
      )
      if (updErr) {
        console.warn(`[${config.pipelineName}] post-pass update failed: ${updErr.message}`)
      } else if (updResult != null) {
        postPassUpdated = Number(updResult) || 0
      }
    } catch (err) {
      console.warn(
        `[${config.pipelineName}] post-pass update threw: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    await stampLastRefreshed(wallet, config.slug, totalUpserted + postPassUpdated)
    await logRun({
      pipelineName: config.pipelineName,
      collectionSlug: config.slug,
      startedAt: startedAtIso, wallet,
      rowsFound: details.length,
      rowsWritten: totalUpserted,
      // Lost chunk rows were found but never written — count them as skipped.
      rowsSkipped: skippedCount + chunkTally.chunkRowsLost,
      ok: chunkTally.chunkErrors === 0,
      error: chunkFailureError(chunkTally),
      extra: {
        on_chain_count: details.length,
        rows_to_write: rows.length,
        skipped_cached: skippedCount,
        ...chunkFailureExtra(chunkTally),
        post_pass_metadata_updated: postPassUpdated,
        terminated_reason: "no_more_moments",
        skip_cached: skipCached,
        force: !!force,
        elapsed_ms: Date.now() - startedMs,
        mode: "details_pinnacle",
      },
    })
    return { rowsFound: details.length, complete: true, nextStartIndex: null }
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
          skip_cached: skipCached, force: !!force, elapsed_ms: elapsedMs,
          error_excerpt: msg.slice(0, 200),
          mode: "details_pinnacle",
        },
      })
      return { rowsFound: 0, complete: true, nextStartIndex: null }
    }
    if (isFlowQueryTimeout(err)) {
      await logRun({
        pipelineName: config.pipelineName,
        collectionSlug: config.slug,
        startedAt: startedAtIso, wallet,
        rowsFound: 0, rowsWritten: totalUpserted, rowsSkipped: 0,
        ok: true,
        extra: {
          terminated_reason: "flow_query_timeout",
          skip_cached: skipCached, force: !!force, elapsed_ms: elapsedMs,
          error_excerpt: msg.slice(0, 200),
          mode: "details_pinnacle",
        },
      })
      console.log(`[${config.pipelineName}] flow_query_timeout wallet=${wallet} — freeing slot, retry next cycle`)
      return { rowsFound: 0, complete: true, nextStartIndex: null }
    }
    if (isComputationLimitError(err)) {
      console.log(`[${config.pipelineName}] computation_limit wallet=${wallet} — falling through to paginated path`)
      return await runPaginatedDetailsBackfill({
        config, startedAtIso, startedMs, wallet, skipCached, force,
        softDeadlineAt: args.softDeadlineAt, startIndex: args.startIndex,
        mode: "pinnacle",
        parentTerminatedReason: "computation_limit_exceeded",
        parentErrorExcerpt: msg.slice(0, 200),
      })
    }
    if (isAccessApiInternalServerError(err)) {
      console.log(`[${config.pipelineName}] access_api_500 wallet=${wallet} — falling through to paginated path`)
      return await runPaginatedDetailsBackfill({
        config, startedAtIso, startedMs, wallet, skipCached, force,
        softDeadlineAt: args.softDeadlineAt, startIndex: args.startIndex,
        mode: "pinnacle",
        parentTerminatedReason: "access_api_error_likely_computation_limit",
        parentErrorExcerpt: msg.slice(0, 200),
      })
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
          skip_cached: skipCached, force: !!force, elapsed_ms: elapsedMs,
          error_excerpt: msg.slice(0, 200),
          mode: "details_pinnacle",
        },
      })
      return { rowsFound: 0, complete: true, nextStartIndex: null }
    }
    await logRun({
      pipelineName: config.pipelineName,
      collectionSlug: config.slug,
      startedAt: startedAtIso, wallet,
      rowsFound: 0, rowsWritten: totalUpserted, rowsSkipped: 0,
      ok: false, error: msg,
      extra: {
        terminated_reason: "error", skip_cached: skipCached,
        force: !!force,
        elapsed_ms: elapsedMs, mode: "details_pinnacle",
      },
    })
    console.error(`[${config.pipelineName}] error during details backfill for ${wallet}: ${msg}`)
    return { rowsFound: 0, complete: true, nextStartIndex: null }
  } finally {
    await releasePipelineLock(lockKey)
  }
}

// runPaginatedDetailsBackfill — mega-wallet recovery path. Triggered from
// the catch handlers of runAllDayDetailsBackfill / runPinnacleDetailsBackfill
// when a single-shot details call breaches Flow's 100k computation budget
// (Cadence error 1110 OR access-API HTTP 500 with `error=internal server
// error` + /v1/scripts in the message). Walks getIDs() in per-mode
// chunk sizes via GET_*_DETAILS_RANGE(addr, start, count) and upserts
// per chunk so partial progress is durable even if a downstream chunk
// fails or the maxDuration soft deadline fires.
//
// Telemetry written to pipeline_runs.extra:
//   pagination_chunks         number of chunks that successfully fetched + upserted
//   pagination_chunk_errors   number of chunks that threw (skipped, not aborted)
//   pagination_total_ids      total getIDs() length walked (= on-chain count)
//   pagination_chunk_size     mode-specific chunk size (allday=1000, pinnacle=500)
//   pagination_elapsed_ms     duration of the paginated run only
//   recovered_from            parent terminated_reason that triggered this
//   parent_error_excerpt      first 200 chars of the original error message
interface PaginatedBackfillArgs extends BackfillArgs {
  mode: "allday" | "pinnacle"
  parentTerminatedReason: string
  parentErrorExcerpt: string
  /**
   * AllDay custody (locked) moments from the studio-platform walk the parent
   * already performed. Written ONCE, on the first chunk (resumeFrom === 0), so a
   * resumed checkpoint doesn't re-write them every tick. Never used to delete.
   */
  studioTriples?: readonly (readonly string[])[]
}

export async function runPaginatedDetailsBackfill(args: PaginatedBackfillArgs): Promise<BackfillRunResult> {
  const {
    config, startedAtIso, startedMs, wallet, skipCached, force,
    mode, parentTerminatedReason, parentErrorExcerpt,
    softDeadlineAt, startIndex,
  } = args
  const paginationStartedMs = Date.now()
  const fullMode = mode === "allday" ? "details_allday_paginated" : "details_pinnacle_paginated"
  const chunkSize = PAGINATION_CHUNK_SIZE_BY_MODE[mode]
  const resumeFrom = Math.max(0, startIndex ?? 0)

  let totalUpserted = 0
  let studioCustodyWritten = 0
  const chunkTally = newChunkTally()
  let postPassUpdated = 0
  let chunksProcessed = 0
  let chunkErrors = 0
  let onChainIds: string[] = []
  let hitSoftDeadline = false
  // checkpoint cursor — the chunk-start offset to resume from. Stays null
  // when the full id list is walked (complete=true). Set by the soft-
  // deadline branch when work remains.
  let nextStartIndex: number | null = null

  try {
    // Step 1: cheap getIDs() walk. Both CADENCE_ALLDAY and CADENCE_PINNACLE
    // do nothing per-NFT — they just borrow the public collection cap and
    // return getIDs(), well under the computation budget even at 40k+.
    const idScript = mode === "allday" ? CADENCE_ALLDAY : CADENCE_PINNACLE
    onChainIds = await fetchOnChainIds(idScript, wallet)

    if (onChainIds.length === 0) {
      // Shouldn't happen — the parent details call already proved IDs
      // existed (otherwise no computation_limit). Defensive log.
      await stampLastRefreshed(wallet, config.slug, 0)
      await logRun({
        pipelineName: config.pipelineName,
        collectionSlug: config.slug,
        startedAt: startedAtIso, wallet,
        rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: true,
        extra: {
          on_chain_count: 0,
          terminated_reason: "no_more_moments",
          recovered_from: parentTerminatedReason,
          parent_error_excerpt: parentErrorExcerpt,
          skip_cached: skipCached, force: !!force,
          elapsed_ms: Date.now() - startedMs,
          pagination_chunks: 0,
          pagination_chunk_errors: 0,
          pagination_total_ids: 0,
          pagination_chunk_size: chunkSize,
          pagination_elapsed_ms: Date.now() - paginationStartedMs,
          mode: fullMode,
        },
      })
      return { rowsFound: 0, complete: true, nextStartIndex: null }
    }

    const cachedMap = skipCached
      ? await loadCachedMomentIdsAndKeys(wallet, config.collectionUuid)
      : new Map<string, boolean>()

    // Step 1.4: AllDay custody (locked) moments. These are NOT in onChainIds —
    // they are not in the wallet's account at all — so they must be written
    // outside the chunk loop, which only walks the on-chain id list. First chunk
    // only (resumeFrom === 0) so a resumed checkpoint doesn't re-write them, and
    // placed BEFORE the pre-flight short-circuit below, which can return early.
    if (resumeFrom === 0 && args.studioTriples?.length) {
      const onChainSet = new Set(onChainIds)
      const nowIso = new Date().toISOString()
      const custodyRows: Array<Record<string, unknown>> = []
      for (const tri of args.studioTriples) {
        const nftId = String(tri[0])
        if (onChainSet.has(nftId)) continue
        if (skipCached && cachedMap.get(nftId) === true) continue
        const serialRaw = tri[2] != null ? Number(tri[2]) : null
        custodyRows.push({
          wallet_address: wallet,
          collection_id: config.collectionUuid,
          moment_id: nftId,
          edition_key: String(tri[1]),
          serial_number: Number.isFinite(serialRaw as number) && (serialRaw as number) > 0
            ? (serialRaw as number)
            : null,
          tier: null,
          player_name: null,
          set_name: null,
          series_number: null,
          acquired_at: null,
          fmv_usd: null,
          last_seen_at: nowIso,
        })
      }
      if (custodyRows.length) {
        studioCustodyWritten = await upsertWmcChunks(custodyRows, config.pipelineName, chunkTally)
        totalUpserted += studioCustodyWritten
      }
    }

    // Step 1.5: pre-flight short-circuit (added 2026-05-08). If every
    // on-chain ID is already cached AND edition_key is already populated
    // on those rows, the chunk loop is pure waste — it would emit 16+
    // Cadence calls (~50-80s for Pinnacle mega-wallets) only to skip
    // every row at the in-loop cache filter. Skipped only when force=true
    // (caller explicitly requested re-walk). Post-pass JOIN UPDATE still
    // runs because pinnacle_editions/editions metadata may have changed
    // since the prior cron tick. The chunk loop is bypassed entirely;
    // pagination_chunks is intentionally absent from telemetry to keep
    // dashboards distinguishing skipped-from-paginated runs cleanly.
    if (skipCached && !force && cachedMap.size > 0 && onChainIds.length > 0) {
      const preflightStartMs = Date.now()
      let allCachedAndEnriched = true
      for (const id of onChainIds) {
        if (cachedMap.get(id) !== true) {
          allCachedAndEnriched = false
          break
        }
      }
      if (allCachedAndEnriched) {
        try {
          if (mode === "allday") {
            // deno-lint-ignore no-explicit-any
            const { data: updResult, error: updErr } = await (supabaseAdmin as any).rpc(
              "backfill_wmc_metadata_from_editions",
              { p_wallet_address: wallet, p_collection_id: config.collectionUuid },
            )
            if (updErr) {
              console.warn(`[${config.pipelineName}] preflight post-pass update failed: ${updErr.message}`)
            } else if (updResult != null) {
              postPassUpdated = Number(updResult) || 0
            }
          } else {
            // deno-lint-ignore no-explicit-any
            const { data: updResult, error: updErr } = await (supabaseAdmin as any).rpc(
              "backfill_pinnacle_wmc_metadata_from_editions",
              { p_wallet_address: wallet },
            )
            if (updErr) {
              console.warn(`[${config.pipelineName}] preflight post-pass update failed: ${updErr.message}`)
            } else if (updResult != null) {
              postPassUpdated = Number(updResult) || 0
            }
          }
        } catch (err) {
          console.warn(
            `[${config.pipelineName}] preflight post-pass update threw: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        await stampLastRefreshed(wallet, config.slug, totalUpserted + postPassUpdated)
        await logRun({
          pipelineName: config.pipelineName,
          collectionSlug: config.slug,
          startedAt: startedAtIso, wallet,
          rowsFound: onChainIds.length, rowsWritten: 0, rowsSkipped: onChainIds.length,
          ok: true,
          extra: {
            on_chain_count: onChainIds.length,
            cached_count_with_key: onChainIds.length,
            terminated_reason: "all_ids_already_enriched",
            recovered_from: parentTerminatedReason,
            parent_error_excerpt: parentErrorExcerpt,
            skip_cached: skipCached,
            force: !!force,
            elapsed_ms: Date.now() - startedMs,
            preflight_elapsed_ms: Date.now() - preflightStartMs,
            post_pass_metadata_updated: postPassUpdated,
            mode: fullMode,
          },
        })
        return { rowsFound: onChainIds.length, complete: true, nextStartIndex: null }
      }
    }

    const now = new Date().toISOString()
    let totalSkippedCached = 0

    // Step 2: chunk loop. Each iteration calls GET_*_DETAILS_RANGE for a
    // mode-specific id window, builds rows, upserts immediately. Per-chunk
    // errors are non-fatal (logged + counted); only a complete inability to
    // proceed throws out to the outer catch.
    //
    // Checkpoint contract (sync-mode):
    //   resumeFrom (= args.startIndex ?? 0)  — start at this chunk-start offset
    //   softDeadlineAt (epoch ms; optional)   — sync-mode caller's budget; the
    //     loop breaks before doing more work past this wall-clock. Falls back
    //     to the legacy PAGINATION_SOFT_DEADLINE_MS guard for fire-and-forget
    //     callers that don't supply a budget.
    //   nextStartIndex (closure) — set to `start` when breaking on deadline so
    //     the caller can resume from this offset on the next round-trip.
    for (let start = resumeFrom; start < onChainIds.length; start += chunkSize) {
      const elapsed = Date.now() - startedMs
      const hitCallerDeadline =
        softDeadlineAt !== undefined && Date.now() >= softDeadlineAt
      if (hitCallerDeadline || elapsed > PAGINATION_SOFT_DEADLINE_MS) {
        hitSoftDeadline = true
        nextStartIndex = start
        console.log(`[${config.pipelineName}] paginated soft deadline hit at chunk start=${start}/${onChainIds.length} (caller_deadline=${hitCallerDeadline})`)
        break
      }
      const count = Math.min(chunkSize, onChainIds.length - start)
      let chunkRows: Array<Record<string, unknown>> = []
      try {
        if (mode === "allday") {
          const raw = await withFlowTimeout(
            fcl.query({
              cadence: GET_UNLOCKED_MOMENT_DETAILS_RANGE,
              args: (arg: any) => [
                arg(wallet, t.Address),
                arg(String(start), t.Int),
                arg(String(count), t.Int),
              ],
            }),
            `GET_UNLOCKED_MOMENT_DETAILS_RANGE(${start},${count})`,
          )
          const triples: string[][] = Array.isArray(raw) ? (raw as any) : []
          for (const tri of triples) {
            if (!Array.isArray(tri) || tri.length < 2) continue
            const nftId = String(tri[0])
            const editionId = String(tri[1])
            const serialRaw = tri[2] != null ? Number(tri[2]) : null
            const serial = Number.isFinite(serialRaw as number) && (serialRaw as number) > 0
              ? (serialRaw as number)
              : null
            if (skipCached && cachedMap.has(nftId)) { totalSkippedCached++; continue }
            chunkRows.push({
              wallet_address: wallet,
              collection_id: config.collectionUuid,
              moment_id: nftId,
              edition_key: editionId,
              serial_number: serial,
              tier: null,
              player_name: null,
              set_name: null,
              series_number: null,
              acquired_at: null,
              fmv_usd: null,
              last_seen_at: now,
            })
          }
        } else {
          type PinDetail = { id: string; editionKey: string | null; serial: string | null }
          const raw = await withFlowTimeout(
            fcl.query({
              cadence: GET_PINNACLE_UNLOCKED_DETAILS_RANGE,
              args: (arg: any) => [
                arg(wallet, t.Address),
                arg(String(start), t.Int),
                arg(String(count), t.Int),
              ],
            }),
            `GET_PINNACLE_UNLOCKED_DETAILS_RANGE(${start},${count})`,
          )
          const details: PinDetail[] = Array.isArray(raw) ? (raw as any) : []
          for (const d of details) {
            const nftId = String(d.id)
            const editionKey = d.editionKey != null ? String(d.editionKey) : null
            const serialRaw = d.serial != null ? Number(d.serial) : null
            const serial = Number.isFinite(serialRaw as number) && (serialRaw as number) > 0
              ? (serialRaw as number)
              : null
            if (skipCached && cachedMap.has(nftId)) { totalSkippedCached++; continue }
            chunkRows.push({
              wallet_address: wallet,
              collection_id: config.collectionUuid,
              moment_id: nftId,
              edition_key: editionKey,
              serial_number: serial,
              character_name: null,
              set_name: null,
              tier: null,
              player_name: null,
              series_number: null,
              acquired_at: null,
              fmv_usd: null,
              last_seen_at: now,
            })
          }
        }
      } catch (chunkErr) {
        chunkErrors++
        const cmsg = chunkErr instanceof Error ? chunkErr.message : String(chunkErr)
        console.warn(`[${config.pipelineName}] paginated chunk start=${start} count=${count} failed: ${cmsg.slice(0, 200)}`)
        continue
      }
      chunksProcessed++

      // NOTE: `chunkErrors` above counts PAGINATION-fetch failures only. Upsert
      // failures are tallied separately in chunkTally and surfaced below.
      totalUpserted += await upsertWmcChunks(
        chunkRows, config.pipelineName, chunkTally, `paginated ${start}+`,
      )
    }

    // Step 3: post-pass JOIN UPDATE. AllDay backfills against editions;
    // Pinnacle against pinnacle_editions. Same RPC the non-paginated path
    // uses — fills tier / player_name / set_name (AllDay) or
    // character_name / set_name / tier / mint_count (Pinnacle).
    try {
      if (mode === "allday") {
        // deno-lint-ignore no-explicit-any
        const { data: updResult, error: updErr } = await (supabaseAdmin as any).rpc(
          "backfill_wmc_metadata_from_editions",
          { p_wallet_address: wallet, p_collection_id: config.collectionUuid },
        )
        if (updErr) {
          console.warn(`[${config.pipelineName}] paginated post-pass update failed: ${updErr.message}`)
        } else if (updResult != null) {
          postPassUpdated = Number(updResult) || 0
        }
      } else {
        // deno-lint-ignore no-explicit-any
        const { data: updResult, error: updErr } = await (supabaseAdmin as any).rpc(
          "backfill_pinnacle_wmc_metadata_from_editions",
          { p_wallet_address: wallet },
        )
        if (updErr) {
          console.warn(`[${config.pipelineName}] paginated post-pass update failed: ${updErr.message}`)
        } else if (updResult != null) {
          postPassUpdated = Number(updResult) || 0
        }
      }
    } catch (err) {
      console.warn(
        `[${config.pipelineName}] paginated post-pass update threw: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    await stampLastRefreshed(wallet, config.slug, totalUpserted + postPassUpdated)

    // PAGINATION-fetch errors stay tolerant: partial progress is captured and the
    // next cron pass re-enriches any wallet still flagged, so only
    // pagination_failed (zero chunks succeeded) marks ok=false on that axis.
    // UPSERT-chunk errors are different — those rows were fetched successfully and
    // then DROPPED, which is data loss, so any of them marks the run ok=false
    // (2026-07-25; they used to be console.error'd and swallowed).
    const allChunksFailed = chunksProcessed === 0 && chunkErrors > 0
    const isComplete = !allChunksFailed && nextStartIndex === null
    await logRun({
      pipelineName: config.pipelineName,
      collectionSlug: config.slug,
      startedAt: startedAtIso, wallet,
      rowsFound: onChainIds.length,
      rowsWritten: totalUpserted,
      // Lost chunk rows were found but never written — count them as skipped.
      rowsSkipped: totalSkippedCached + chunkTally.chunkRowsLost,
      ok: !allChunksFailed && chunkTally.chunkErrors === 0,
      error: allChunksFailed
        ? "all_pagination_chunks_failed"
        : chunkFailureError(chunkTally),
      extra: {
        on_chain_count: onChainIds.length,
        skipped_cached: totalSkippedCached,
        ...chunkFailureExtra(chunkTally),
        post_pass_metadata_updated: postPassUpdated,
        terminated_reason: allChunksFailed
          ? "pagination_failed"
          : (hitSoftDeadline ? "soft_deadline" : "no_more_moments"),
        recovered_from: parentTerminatedReason,
        parent_error_excerpt: parentErrorExcerpt,
        skip_cached: skipCached,
        force: !!force,
        elapsed_ms: Date.now() - startedMs,
        pagination_chunks: chunksProcessed,
        pagination_chunk_errors: chunkErrors,
        pagination_total_ids: onChainIds.length,
        studio_custody_written: studioCustodyWritten,
        pagination_chunk_size: chunkSize,
        pagination_elapsed_ms: Date.now() - paginationStartedMs,
        pagination_resume_from: resumeFrom,
        pagination_next_start_index: nextStartIndex,
        mode: fullMode,
      },
    })
    return { rowsFound: onChainIds.length, complete: isComplete, nextStartIndex }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await logRun({
      pipelineName: config.pipelineName,
      collectionSlug: config.slug,
      startedAt: startedAtIso, wallet,
      rowsFound: onChainIds.length,
      rowsWritten: totalUpserted,
      rowsSkipped: 0,
      ok: false, error: msg,
      extra: {
        terminated_reason: "pagination_failed",
        recovered_from: parentTerminatedReason,
        parent_error_excerpt: parentErrorExcerpt,
        skip_cached: skipCached,
        force: !!force,
        elapsed_ms: Date.now() - startedMs,
        pagination_chunks: chunksProcessed,
        pagination_chunk_errors: chunkErrors,
        pagination_total_ids: onChainIds.length,
        studio_custody_written: studioCustodyWritten,
        pagination_chunk_size: chunkSize,
        pagination_elapsed_ms: Date.now() - paginationStartedMs,
        mode: fullMode,
      },
    })
    console.error(`[${config.pipelineName}] paginated backfill failed for ${wallet}: ${msg}`)
    return { rowsFound: onChainIds.length, complete: true, nextStartIndex: null }
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

// Golazos details script — the edition_key/serial_number analogue of AllDay's
// GET_UNLOCKED_MOMENT_DETAILS. Verified against mainnet contract source
// (A.87ca73a41bb50ad5.Golazos, which is itself "Adapted from: AllDay.cdc"):
// `Golazos.NFT` exposes `editionID: UInt64` + `serialNumber: UInt64`.
//
// Borrow type is `&{NonFungibleToken.CollectionPublic}`, NOT the narrower
// `&{NonFungibleToken.Collection}` (2026-08-04 fix). CollectionPublic is the
// interface the standard NFT contract publishes to /public, and — verified
// against onflow/flow-nft NonFungibleToken.cdc — it declares BOTH getIDs() and
// borrowNFT(), so it is sufficient for this read AND it is the broader
// interface (Collection inherits CollectionPublic), so it resolves for every
// wallet the narrow type did PLUS the ones whose capability is published only
// as CollectionPublic. The narrow `&{...Collection}` borrow returned nil for
// ~23 live wallets holding real Golazos moments (max_onchain 0 across every
// scan) even though the sibling ID-only CADENCE_GOLAZOS — which borrows exactly
// this CollectionPublic type — resolves for them, which is what pinned the
// root cause: the returned [] was a nil borrow, not an empty wallet.
//
// Two public paths are tried because they disagree: the contract declares
// CollectionPublicPath = /public/GolazosNFTCollection, but the long-standing
// ID-only CADENCE_GOLAZOS below borrows the legacy /public/GolazoNFTCollection
// (no trailing "s") and demonstrably resolves for live wallets. Trying the
// canonical path first and falling back preserves whichever a wallet linked.
export const GET_GOLAZOS_MOMENT_DETAILS = `
import Golazos from 0x87ca73a41bb50ad5
import NonFungibleToken from 0x1d7e57aa55817448
access(all) fun main(addr: Address): [[UInt64]] {
  let r: [[UInt64]] = []
  let acct = getAccount(addr)
  let ref = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(/public/GolazosNFTCollection)
    ?? acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(/public/GolazoNFTCollection)
  if ref == nil { return r }
  for id in ref!.getIDs() {
    let nft = ref!.borrowNFT(id)!
    let g = nft as! &Golazos.NFT
    r.append([id, g.editionID, g.serialNumber])
  }
  return r
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
