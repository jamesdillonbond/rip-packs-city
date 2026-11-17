// lib/pipeline/terminal-run.ts
//
// The TERMINAL `pipeline_runs` row for a synchronous cron route, in ONE place.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// Sibling to `lib/pipeline/heartbeat.ts`, which covers the `after()` routes.
// This one covers the other shape: a route that does its work inline and
// returns, so its outcome is knowable at the moment it responds.
//
// Measured 2026-08-29 (register R68). `.github/workflows/rpc-pipeline.yml`
// calls six production endpoints ~3×/day. FOUR of them wrote NO `pipeline_runs`
// row of any kind — no terminal row, no heartbeat, nothing:
//
//   /api/fmv-backfill            228 lines   0 rows / 48 h
//   /api/backfill                285 lines   0 rows / 48 h
//   /api/cron/price-snapshots     70 lines   0 rows / 48 h
//   /api/backfill-player-names    44 lines   0 rows / 48 h
//
// with `/api/fmv-recalc` as the positive control **in the same instrument**:
// it logs under its own name and showed 130 rows over the same 48 hours. The
// zero was the routes, not the query.
//
// The consequence is precise and worth stating in those words: **the run
// frequency of those four endpoints was not merely low, it was UNKNOWABLE from
// any durable store.** The workflow could not fail (six of six
// `continue-on-error`, non-200 emitting only `::warning::`), so 30 of 30 recent
// runs read `success` by construction; and GHA log retention is finite, so once
// the logs age out there is nothing left to read at all.
//
// ── WHY A HELPER RATHER THAN A FIFTH HAND-ROLL ─────────────────────────────
// The heartbeat helper's own header records what happened last time this was
// left to call sites: five routes hand-rolled it, all five agreed on the hard
// part and NO TWO agreed on the rest, and the divergence that mattered was
// `rows_* = 0` — a measurement nobody took, which made a live pipeline look
// inert in the 2026-08-16 retirement sweep. That is the `?? 0` fabrication
// class, in telemetry. So:
//
// ⚠ **THE COUNTERS DEFAULT TO `null`, NEVER `0`.** A route that did not count
// something must publish "not measured", not "measured zero". `log_pipeline_run`
// stopped COALESCEing an explicit NULL to 0 in migration 20260829040000, so
// passing `null` now survives the round trip — which is what makes this default
// safe to rely on.
//
// ⚠ **NEVER THROWS.** Telemetry must not be able to take down the pipeline it
// watches. supabase-js RETURNS errors rather than throwing, so the returned
// `error` is the only evidence of a failed write; a bare `await` inside a
// try/catch would report every failure as a success. Returns whether the row
// landed so a caller can log the miss — callers must NOT branch pipeline
// behaviour on it.
//
// ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
// ⚠ It cannot record a `maxDuration` kill: the platform terminates the whole
// function, so the terminal row dies with it, and `try/catch`/`finally` do not
// save you. A route that can be wall-killed and whose invocation frequency must
// be knowable needs a heartbeat as WELL (see `writeInvocationHeartbeat`) — the
// kill is then read by CORRELATION (heartbeat present, terminal row absent).
//
// ⚠ A request rejected at AUTH writes nothing, deliberately: it has not run.
// The absence then means "never invoked", which covers both a schedule that did
// not fire and a token that drifted. Those need the same investigation, so
// collapsing them loses nothing a separate row would have told you.

import { supabaseAdmin } from "@/lib/supabase"

export type TerminalRunOptions = {
  /** The pipeline name. Use the route's own stable name, not the workflow step's. */
  pipeline: string
  /** When the run began — captured BEFORE the work, so the duration is real. */
  startedAt: Date | number | string
  ok: boolean
  /** The error string on a failure. Null on success. */
  error?: string | null
  /** ⚠ Omit rather than passing 0 when the route did not count this. */
  rowsFound?: number | null
  rowsWritten?: number | null
  rowsSkipped?: number | null
  collectionSlug?: string | null
  cursorBefore?: string | null
  cursorAfter?: string | null
  extra?: Record<string, unknown> | null
}

function toIso(at: Date | number | string): string {
  if (at instanceof Date) return at.toISOString()
  if (typeof at === "number") return new Date(at).toISOString()
  return at
}

/** The RPC argument object, extracted so a test can pin it without a database. */
export function buildTerminalRunArgs(opts: TerminalRunOptions) {
  return {
    p_pipeline: opts.pipeline,
    p_started_at: toIso(opts.startedAt),
    // ⚠ `?? null`, NOT `?? 0`. See the header.
    p_rows_found: opts.rowsFound ?? null,
    p_rows_written: opts.rowsWritten ?? null,
    p_rows_skipped: opts.rowsSkipped ?? null,
    p_ok: opts.ok,
    p_error: opts.error ?? null,
    p_collection_slug: opts.collectionSlug ?? null,
    p_cursor_before: opts.cursorBefore ?? null,
    p_cursor_after: opts.cursorAfter ?? null,
    p_extra: opts.extra ?? {},
  }
}

/**
 * Write the terminal row. Call it on EVERY exit path past auth — including the
 * early returns. An early return that skips the log is the exact defect that
 * made saturation-era `fmv-recalc` timeouts look like a cron that never fired.
 */
export async function logTerminalRun(
  opts: TerminalRunOptions,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
): Promise<boolean> {
  const args = buildTerminalRunArgs(opts)
  try {
    const { error } = await db.rpc("log_pipeline_run", args)
    if (error) {
      console.log(`[${opts.pipeline}] terminal run log failed (non-fatal): ${error.message}`)
      return false
    }
    return true
  } catch (err) {
    console.log(
      `[${opts.pipeline}] terminal run log threw (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return false
  }
}
