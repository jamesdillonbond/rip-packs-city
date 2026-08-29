// lib/pipeline/heartbeat.ts
//
// The invocation heartbeat for `after()` routes, in ONE place.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// A `CRON-30S` route returns 202 immediately and does its work inside
// `after()`. ⚠ `try/catch` CANNOT catch a `maxDuration` kill: the platform
// terminates the whole function, taking the terminal `pipeline_runs` insert
// with it, while the 202 has already told the caller it succeeded. Over two
// months that hid 21 silent kills. A `finally` does not save you either — it
// does not run reliably under the lambda lifecycle.
//
// So kills are read by CORRELATION, and that needs a marker row written BEFORE
// the work begins:
//   heartbeat + terminal row -> ran to completion
//   heartbeat only           -> after() dropped or killed at the wall
//   neither                  -> route never reached (cron / auth)
//
// ── WHY A HELPER, MEASURED RATHER THAN ASSERTED (2026-08-20) ───────────────
// Five routes had hand-rolled this. All five agreed on the hard part (the
// separate pipeline name) and NO TWO agreed on the rest. Counted live in
// `pipeline_runs`:
//
//   drain-fmv-cold-tail-heartbeat   111 rows   rows NULL      duration 0   ✅
//   fmv-recalc-heartbeat            564 rows   rows 0         duration 0
//   candy-listings-indexer-heartbeat 22 rows   rows 0         duration up to 47,462 ms
//   candy-offers-indexer-heartbeat   12 rows   rows 0         duration up to 24,803 ms
//   candy-editions-ingest-heartbeat   3 rows   rows 0         duration up to 474 ms
//
// Neither divergence is a hidden bug — both are DOCUMENTED at their call sites,
// which is the point. The `rows 0` shape is the fabricated-measurement class
// this repo bans (`?? 0` on a count): a marker row measures nothing, so a 0 is a
// number nobody read, and it is what made a pipeline look inert in the 2026-08-16
// retirement sweep. The nonzero durations are the three RPC call sites
// publishing their own INSERT latency as a run duration, because
// `log_pipeline_run` has no `p_finished_at` parameter and `finished_at` DEFAULTS
// TO `now()` while `duration_ms` is GENERATED from the pair.
//
// ⚠ UPDATE 2026-08-28: HALF OF THAT IS NOW FIXED AT THE SOURCE, so do not inherit
// the whole rationale. `log_pipeline_run` no longer COALESCEs an explicit NULL
// counter to 0 (migration 20260829040000) — it had been overwriting two callers
// that deliberately passed NULL, which is the same fabrication this comment names.
// **The remaining reason to write the table directly is `finished_at`**: the RPC
// still has no `p_finished_at`, so it cannot pin a marker's duration to 0, and that
// alone is why this helper does not delegate.
//
// Both were survivable only because every reader knew the caveat. That is the
// failure mode: a contract whose correctness lives in five comments is a
// contract that drifts, and "read `extra`/`ok`, never the duration" is not
// something the next reader of a dashboard will know.
//
// This helper writes the table DIRECTLY (the only way to pin `finished_at`) and
// makes every field the same everywhere. `__tests__/pipeline-heartbeat.test.ts`
// drives it; `__tests__/after-route-heartbeat-ratchet.test.ts` counts the cron
// `after()` routes still missing one.
//
// ⚠ WHAT A HEARTBEAT DOES NOT DO. It cannot detect its own kill, and no test can
// simulate one. It records that the invocation STARTED. The detection is the
// correlation query, run elsewhere:
//   SELECT hb.started_at FROM pipeline_runs hb
//   WHERE hb.pipeline = '<name>-heartbeat'
//     AND hb.started_at < now() - interval '10 minutes'
//     AND NOT EXISTS (SELECT 1 FROM pipeline_runs t
//       WHERE t.pipeline = '<name>'
//         AND t.started_at BETWEEN hb.started_at - interval '5 s'
//                              AND hb.started_at + interval '5 s');

import { supabaseAdmin } from "@/lib/supabase"

export const HEARTBEAT_SUFFIX = "-heartbeat"

/**
 * The marker's pipeline name.
 *
 * ⚠ A SEPARATE NAME IS THE LOAD-BEARING PART, not a formatting choice. These
 * pipelines sit on `pipeline_cadence_watchlist`; a marker written under the REAL
 * name would refresh `last_run` on every tick and silence
 * `detect_stalled_pipelines()` on precisely the outage the marker exists to
 * expose. The heartbeat would then hide the failure it was added to reveal.
 *
 * Idempotent: a caller that passes an already-suffixed name gets it back
 * unchanged rather than a `foo-heartbeat-heartbeat` row that no correlation
 * query would ever match.
 */
export function heartbeatPipelineName(pipeline: string): string {
  return pipeline.endsWith(HEARTBEAT_SUFFIX) ? pipeline : `${pipeline}${HEARTBEAT_SUFFIX}`
}

export interface HeartbeatRow {
  pipeline: string
  started_at: string
  finished_at: string
  ok: true
  rows_found: null
  rows_written: null
  rows_skipped: null
  collection_slug?: string | null
  cursor_before?: string | null
  cursor_after?: string | null
  extra: Record<string, unknown>
}

export interface HeartbeatOptions {
  /** The REAL pipeline name. The suffix is appended here, never by the caller. */
  pipeline: string
  /** Invocation start, as `Date.now()` at the top of the route. */
  startedAtMs: number
  /** Anything that helps read the marker later — limits, offsets, filters. */
  extra?: Record<string, unknown>
  collectionSlug?: string | null
  /** Resume position, when the pipeline is cursored. */
  cursor?: string | null
}

/**
 * Build the marker row. Pure, so the whole contract is testable without a DB.
 */
export function buildHeartbeatRow(opts: HeartbeatOptions): HeartbeatRow {
  const at = new Date(opts.startedAtMs).toISOString()
  const row: HeartbeatRow = {
    pipeline: heartbeatPipelineName(opts.pipeline),
    started_at: at,
    // ⚠ Pinned to started_at, NOT omitted. `finished_at` DEFAULTS TO now() and
    // `duration_ms` is GENERATED ALWAYS AS (finished_at - started_at), so an
    // omitted value publishes this INSERT's own latency as a run duration —
    // measured live at 42 ms to 56 s across 514 rows, indistinguishable from a
    // real reading. A hard 0 is an obvious sentinel instead.
    finished_at: at,
    // ⚠ Always true. These rows must not inflate `v_pipeline_failure_rates`,
    // and an `ok:false` marker would fire the alerting for a run that has not
    // failed — it has not finished.
    ok: true,
    // ⚠ NULL, never 0. The column DEFAULTS to 0, so omitting these fields
    // publishes a measurement nobody took — the `?? 0` shape, in telemetry.
    // A retirement sweep reading `rows_written = 0` concluded a live pipeline
    // was inert on 2026-08-16.
    rows_found: null,
    rows_written: null,
    rows_skipped: null,
    extra: { phase: "started", ...(opts.extra ?? {}) },
  }
  if (opts.collectionSlug != null) row.collection_slug = opts.collectionSlug
  if (opts.cursor != null) {
    row.cursor_before = opts.cursor
    row.cursor_after = opts.cursor
  }
  return row
}

/**
 * Write the marker. Awaited BEFORE the work — that ordering is the whole point,
 * because a row written after the work cannot survive the kill it exists to
 * record.
 *
 * ⚠ NEVER THROWS, and never rejects. Telemetry must not be able to take down
 * the pipeline it is watching, and `after()` bodies are not wrapped by the
 * route's own error handling. Returns whether the row landed so a caller can
 * log the miss; callers must not branch pipeline behaviour on it.
 */
export async function writeInvocationHeartbeat(
  opts: HeartbeatOptions,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
): Promise<boolean> {
  const row = buildHeartbeatRow(opts)
  try {
    // supabase-js RETURNS errors rather than throwing, so the returned `error`
    // is the only evidence of a failed write — a bare `await` in a try/catch
    // would report every failure as a success.
    const { error } = await db.from("pipeline_runs").insert(row)
    if (error) {
      console.log(`[${row.pipeline}] heartbeat insert failed (non-fatal): ${error.message}`)
      return false
    }
    return true
  } catch (err) {
    console.log(
      `[${row.pipeline}] heartbeat insert threw (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return false
  }
}
