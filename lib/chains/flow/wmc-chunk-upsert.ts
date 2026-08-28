// lib/chains/flow/wmc-chunk-upsert.ts
//
// The wallet_moments_cache chunk writer and its failure/recovery tally.
//
// ⚠ WHY THIS IS ITS OWN MODULE (2026-08-28). It used to live in
// wallet-backfill-helpers.ts, which imports fcl, @onflow/types and four Cadence
// script modules at module scope. app/api/wallet-backfill/route.ts (Top Shot)
// therefore could not import the shared writer without dragging all of that in,
// and its test suite stubs the whole helpers module out — so the route kept its
// own COPY of the upsert loop and the counters, and the two drifted. Splitting
// the writer out (it needs exactly two things: a Supabase client and the retry
// helper) lets every caller share one implementation.

import { supabaseAdmin } from "@/lib/supabase"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"

/** Rows per upsert_wmc_batch call. */
export const UPSERT_CHUNK = 200

/**
 * Running tally of wallet_moments_cache upsert-chunk FAILURES for one run.
 *
 * WHY THIS EXISTS (2026-07-25). Every `upsert_wmc_batch` chunk error used to be
 * `console.error`'d and then swallowed: there was no counter, `rows_skipped` did
 * not include the lost rows, and the run still logged `ok: true`. That made
 * chunk-level data loss structurally invisible — 3,497 wallet-backfill runs
 * reported 0 failures over a window in which ~37 chunks of up to 200 rows each
 * were silently dropped. (`chunkErrors` on the paginated path counted only
 * PAGINATION-fetch failures, never upsert failures.)
 *
 * The shape mirrors app/api/cron/ufc-enrichment-drain/route.ts, which already
 * surfaces its write errors correctly. Difference: the drain `break`s on the
 * first error, whereas these runs continue through the remaining chunks so
 * partial progress is still banked — hence a COUNT plus the first error message,
 * rather than a single writeError.
 */
export interface ChunkFailureTally {
  /** number of upsert chunks that errored (AFTER retries — a recovered chunk is not counted) */
  chunkErrors: number
  /** rows in those chunks — an upper bound on rows lost this run */
  chunkRowsLost: number
  /** first error message seen, for the pipeline_runs.error column */
  firstChunkError: string | null
  /** chunks that failed at least once and then SUCCEEDED on a retry */
  chunkRetryRecoveries: number
  /** rows in those recovered chunks — what the retry actually saved */
  chunkRowsRecovered: number
  /**
   * Run-level EXTRA time (ms) still available for retrying. A first attempt is
   * never charged against it — only a chunk that actually retried is — so a
   * saturation spell can cost this run at most CHUNK_RETRY_RUN_BUDGET_MS on top
   * of the work it would have done anyway. Once exhausted the remaining chunks
   * fall back to single-attempt, which is the pre-2026-08-28 behaviour.
   */
  retryBudgetMsLeft: number
}

/**
 * Run-level ceiling on time spent retrying failed upsert chunks.
 *
 * ⚠ SIZED AGAINST THE TIGHTEST CALLER, NOT THE TYPICAL ONE. These helpers are
 * shared by routes whose maxDuration ranges from 60 s (golazos) to 800 s
 * (multicollection); 10 s is ~17% of the smallest budget and <2% of the
 * largest. It bounds EXTRA time only — the first attempt on every chunk is
 * unaffected — so the worst case is that a saturated run finishes 10 s later
 * than it used to, never that a healthy chunk is cut short.
 */
export const CHUNK_RETRY_RUN_BUDGET_MS = 10_000

export function newChunkTally(): ChunkFailureTally {
  return {
    chunkErrors: 0,
    chunkRowsLost: 0,
    firstChunkError: null,
    chunkRetryRecoveries: 0,
    chunkRowsRecovered: 0,
    retryBudgetMsLeft: CHUNK_RETRY_RUN_BUDGET_MS,
  }
}

/** Non-null pipeline_runs.error text when any chunk failed, else null. */
export function chunkFailureError(t: ChunkFailureTally): string | null {
  if (t.chunkErrors === 0) return null
  return `wmc_upsert_chunk_failures=${t.chunkErrors} rows_lost=${t.chunkRowsLost}` +
    (t.firstChunkError ? ` first=${t.firstChunkError.slice(0, 200)}` : "")
}

/** The chunk-failure fields to spread into a logRun `extra`. */
export function chunkFailureExtra(t: ChunkFailureTally): Record<string, unknown> {
  return {
    chunk_errors: t.chunkErrors,
    chunk_rows_lost: t.chunkRowsLost,
    first_chunk_error: t.firstChunkError,
    // ⚠ ALWAYS EMITTED, including as 0 on a clean run. CLAUDE.md: fixing a
    // guard without fixing the field an observer keys on leaves the incidence
    // unmeasurable. A key that appears only when non-zero cannot answer 'how
    // often did retrying save us' — the absent-vs-zero distinction is exactly
    // what made 8 of 10 saturation breakers unreadable.
    chunk_retry_recoveries: t.chunkRetryRecoveries,
    chunk_rows_recovered: t.chunkRowsRecovered,
  }
}

/**
 * Write ONE already-sliced chunk to wallet_moments_cache, retrying transient
 * failures. Returns rows actually written (0 if the chunk was ultimately lost).
 *
 * ⚠ WHY THIS RETRIES, WHEN `withQueryDeadline` DELIBERATELY DOES NOT (2026-08-28).
 * The argument against retrying — *"a retry doubles the worst-case hold on a pool
 * that is already the thing saturating"* — is correct for a page render a human
 * is waiting on, where the reader pays the cost. It is the wrong trade here, and
 * the measurement is unambiguous: over the 7 days to 2026-08-28 the
 * wallet-backfill family reported **207,287 rows lost across 1,010 failed
 * chunks, and 100% of them carried one of exactly two TRANSIENT messages** —
 * 978 chunks / 188,521 rows on `Timed out acquiring connection from connection
 * pool.` and 32 chunks / 18,766 rows on `canceling statement due to lock
 * timeout`. Not one was a logic error. `isTransient` already classifies both as
 * retryable; this loop simply never asked it, because it called a bare `.rpc()`.
 *
 * The alternative to retrying here is not "spare the pool" — it is DROP THE
 * ROWS. `upsert_wmc_batch` is an upsert, so a retry is idempotent, and both
 * error classes abort BEFORE the statement commits (a pool acquire never starts
 * one; a lock timeout rolls one back), so no retry can double-write.
 *
 * ⚠ THIS ALSO ADDS THE FIRST CLIENT-SIDE DEADLINE THESE WRITES HAVE EVER HAD.
 * The bare `.rpc()` had none at all. The 45 s default is deliberately ABOVE
 * service_role's 30 s statement_timeout, so it cannot cut short a statement
 * Postgres would have finished and answered — see DEFAULT_RPC_TIMEOUT_MS.
 *
 * ⚠ WHAT THIS DOES NOT CLAIM. The dominant cause is the seed-wave saturation
 * spell, in which the pool stays exhausted for far longer than ~2 s of backoff.
 * PARTIAL recovery is the honest expectation, not full recovery — which is
 * exactly why `chunk_retry_recoveries` / `chunk_rows_recovered` are logged on
 * every run including clean ones. Read those columns before claiming this
 * closed the class.
 */
async function upsertWmcOneChunk(
  chunk: Array<Record<string, unknown>>,
  pipelineName: string,
  tally: ChunkFailureTally,
  chunkLabel: string,
): Promise<number> {
  if (chunk.length === 0) return 0

  // The budget gates WHETHER we retry, never how long an attempt may run.
  // Slicing the per-attempt deadline down as the budget drains would start
  // cancelling statements Postgres would have answered — the precise failure
  // mode DEFAULT_RPC_TIMEOUT_MS exists to avoid.
  const mayRetry = tally.retryBudgetMsLeft > 0
  let retried = false
  const startedMs = Date.now()

  const { data, error } = await rpcWithRetry<{ written?: number }>(
    supabaseAdmin as never,
    "upsert_wmc_batch",
    { p_rows: chunk },
    mayRetry
      ? {
          attempts: 3,
          // 400 ms base -> 400 ms + 1600 ms of backoff. Longer than the page
          // default of 50 ms: a saturated pool does not clear in a quarter of a
          // second, and nobody is waiting on this write.
          baseDelayMs: 400,
          onRetry: () => {
            retried = true
          },
        }
      : { attempts: 1 },
  )

  // Charge the WHOLE elapsed time of any call that retried — an over-estimate,
  // which is the safe direction for a ceiling whose job is to stop a saturation
  // spell from pushing a 60 s route past its maxDuration.
  if (retried) {
    tally.retryBudgetMsLeft = Math.max(0, tally.retryBudgetMsLeft - (Date.now() - startedMs))
  }

  if (error) {
    tally.chunkErrors++
    tally.chunkRowsLost += chunk.length
    if (tally.firstChunkError === null) tally.firstChunkError = error.message
    console.error(
      `[${pipelineName}] upsert err chunk=${chunkLabel}: ${error.message}`,
    )
    return 0
  }

  if (retried) {
    tally.chunkRetryRecoveries++
    tally.chunkRowsRecovered += chunk.length
    console.log(
      `[${pipelineName}] upsert chunk=${chunkLabel} RECOVERED by retry (${chunk.length} rows)`,
    )
  }
  return Number(data?.written ?? 0)
}

/**
 * The chunk writer, exported for the Top Shot wallet-backfill route, which
 * buffers and flushes its own chunks rather than handing this module a complete
 * array. It shares this function so the retry, the tally and the recovery
 * counters cannot drift between the two implementations — the class of bug
 * CLAUDE.md flags as "grep for the EXPRESSION, not the file".
 */
export async function upsertWmcChunkWithRetry(
  chunk: Array<Record<string, unknown>>,
  pipelineName: string,
  tally: ChunkFailureTally,
  chunkLabel: string,
): Promise<number> {
  return upsertWmcOneChunk(chunk, pipelineName, tally, chunkLabel)
}
