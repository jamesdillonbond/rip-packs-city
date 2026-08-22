// lib/dune/budget.ts
//
// The Dune spend budget, in ONE place, for all three Dune lanes.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// Dune stops us on DATAPOINTS (~= rows returned by the API), not on the credits
// gauge dune.com shows — the gauge read comfortable at ~900 of 2,500 while the
// datapoint limit was already exhausted (2026-07-19). Every lane here walks flat
// out until the API answers `HTTP 402 … would exceed your configured datapoint
// limit per billing cycle`, so on 2026-07-24 the cycle reset at 00:00 UTC and
// both lanes had spent the whole month by 06:11 — measured in
// docs/dune-budget-analysis-2026-07-26.md, not estimated.
//
// Nothing counted the spend, so nothing could pace it. This is the counter and
// the gate: `readDuneBudget()` before buying, `recordDuneUsage()` after each
// page. State lives in `dune_budget_state` / `dune_api_usage` (migration
// audit_20260822_dune_datapoint_budget_ledger) so the caps change with one
// UPDATE — no deploy, no cron edit.
//
// ── FAIL CLOSED, DELIBERATELY ──────────────────────────────────────────────
// ⚠ An unreadable budget is NOT "plenty of budget". supabase-js RETURNS errors
// rather than throwing, so a failed RPC resolves `{ data: null, error }` — the
// exact shape that a `?? 0` or a truthiness check publishes as a number nobody
// measured. Here that number would authorise spending. So a failed read yields
// `read: "failed"` with `rowsAllowedNow: 0`, and callers must surface it as
// `ok: false` (the run could not prove it had budget) rather than as a
// successful no-op.
//
// ⚠ ROWS, NOT DATAPOINTS, ARE WHAT IS ENFORCED. Rows returned is exact — the
// route counts what it received. Datapoints are rows x columns, which is Dune's
// documented shape but not a figure we can read back from them, so they are
// recorded as `datapoints_est` and nothing gates on them.

import { supabaseAdmin } from "@/lib/supabase"

/** Endpoints of workers/dune-proxy. Only `results` returns billable rows. */
export type DuneEndpoint = "execute" | "status" | "results"

export interface DuneBudget {
  /** "ok" = the policy was read. "failed" = it was not, and nothing may be bought. */
  read: "ok" | "failed"
  /** False when the policy row is missing — treated exactly like a failed read. */
  configured: boolean
  /** The one-row kill switch (`dune_budget_state.paused`). */
  paused: boolean
  /** Rows this lane may still buy right now. 0 means stop. */
  rowsAllowedNow: number
  /** Why it is 0, when it is 0 — goes straight into `pipeline_runs.extra`. */
  reason: string | null
  /** The full status payload, for `extra` so a paced run is diagnosable later. */
  raw: Record<string, unknown> | null
}

const FAILED = (reason: string): DuneBudget => ({
  read: "failed",
  configured: false,
  paused: false,
  rowsAllowedNow: 0,
  reason,
  raw: null,
})

function toInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN
  return Number.isFinite(n) ? Math.floor(n) : null
}

/**
 * Read the spend policy. NEVER THROWS — a budget check must not be able to take
 * down the pipeline it is metering — but a failure is reported as such, never
 * smoothed into a permissive default.
 */
export async function readDuneBudget(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
): Promise<DuneBudget> {
  let payload: unknown
  try {
    const { data, error } = await db.rpc("dune_budget_status")
    if (error) return FAILED(`budget read: ${error.message}`)
    payload = data
  } catch (e) {
    return FAILED(`budget read threw: ${e instanceof Error ? e.message : String(e)}`)
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return FAILED("budget read: unexpected payload")
  }
  const raw = payload as Record<string, unknown>

  if (raw.configured !== true) {
    return {
      ...FAILED(typeof raw.reason === "string" ? raw.reason : "dune budget not configured"),
      raw,
    }
  }

  const allowed = toInt(raw.rows_allowed_now)
  if (allowed === null) return { ...FAILED("budget read: rows_allowed_now unreadable"), raw }

  const paused = raw.paused === true
  return {
    read: "ok",
    configured: true,
    paused,
    rowsAllowedNow: Math.max(0, allowed),
    reason: paused
      ? "dune_budget_state.paused"
      : allowed <= 0
        ? "day/cycle row cap reached"
        : null,
    raw,
  }
}

/**
 * Rows x columns, from the rows themselves. Columns come from the widest row
 * present, so a Dune result whose first row happens to carry a null-dropped key
 * cannot under-count the whole page. Returns 0 for an empty page — nothing was
 * returned, which is a measurement, not a missing one.
 */
export function estimateDatapoints(rows: Array<Record<string, unknown>>): number {
  return rows.length * columnCount(rows)
}

/**
 * Widest column count in a page, or 0 for an empty page. Separate from
 * `estimateDatapoints` because the ledger stores the two factors, not just the
 * product — a wrong column count is then visible instead of baked in.
 */
export function columnCount(rows: Array<Record<string, unknown>>): number {
  if (!Array.isArray(rows) || rows.length === 0) return 0
  let cols = 0
  for (const r of rows) {
    const n = r && typeof r === "object" ? Object.keys(r).length : 0
    if (n > cols) cols = n
  }
  return cols
}

/**
 * Terminal `pipeline_runs` row for a tick that bought nothing because the budget
 * said no. Shared by all three lanes so the shape cannot drift between them.
 *
 * ⚠ THE `ok` SPLIT IS THE LOAD-BEARING PART. A run stopped by a CONFIGURED cap
 * or by `paused` did exactly what it was told, so `ok: true` — pacing is not a
 * failure and must not page anyone. A run stopped because the budget could not
 * be READ proved nothing, so `ok: false`: that is an unknown state, and the one
 * thing worse than overspending is a lane that silently stops and reports
 * success. `extra.budget_stopped` is set either way, so the daily rollup's
 * `extra_key_counts` counts paced ticks without anyone reading `error`.
 */
export async function logDuneBudgetStop(
  opts: {
    pipeline: string
    startedAt: string
    budget: DuneBudget
    extra?: Record<string, unknown>
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
): Promise<void> {
  const failed = opts.budget.read === "failed"
  try {
    await db.rpc("log_pipeline_run", {
      p_pipeline: opts.pipeline,
      p_started_at: opts.startedAt,
      // A measured zero: the run deliberately asked Dune for nothing.
      p_rows_found: 0,
      p_rows_written: 0,
      p_rows_skipped: 0,
      p_ok: !failed,
      p_error: failed ? `dune budget unreadable: ${opts.budget.reason ?? "unknown"}` : null,
      p_extra: {
        budget_stopped: true,
        budget_read: opts.budget.read,
        budget_reason: opts.budget.reason,
        budget_paused: opts.budget.paused,
        budget_status: opts.budget.raw,
        ...(opts.extra ?? {}),
      },
    })
  } catch (e) {
    console.log(
      `[${opts.pipeline}] budget-stop log_pipeline_run failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
  }
}

export interface DuneUsage {
  pipeline: string
  endpoint: DuneEndpoint
  queryId?: string | null
  /** Exact count of rows received. Omit for endpoints that return none. */
  rows?: number | null
  /** Widest column count seen on this page. Omit when no rows were returned. */
  columns?: number | null
  httpStatus?: number | null
  note?: string | null
}

/**
 * Append one call to the ledger.
 *
 * ⚠ NEVER THROWS. Metering must not be able to fail the pipeline it meters.
 * Returns whether the row landed so a caller can note the miss; callers must not
 * branch pipeline behaviour on it.
 *
 * ⚠ Written PER PAGE, not once per run. A run killed at `maxDuration` has still
 * spent every datapoint it bought, and a ledger that only writes at the end
 * would under-count exactly the runs that overspent.
 */
export async function recordDuneUsage(
  usage: DuneUsage,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
): Promise<boolean> {
  const rows = usage.rows == null ? null : Math.max(0, Math.floor(usage.rows))
  const cols = usage.columns == null ? null : Math.max(0, Math.floor(usage.columns))
  try {
    const { error } = await db.from("dune_api_usage").insert({
      pipeline: usage.pipeline,
      endpoint: usage.endpoint,
      query_id: usage.queryId ?? null,
      // ⚠ NULL, never 0, when nothing was measured. A 0 row-count on an
      // /execute is a number nobody took, and it would make the ledger read as
      // "this call was free".
      rows_returned: rows,
      columns_returned: cols,
      datapoints_est: rows != null && cols != null ? rows * cols : null,
      http_status: usage.httpStatus ?? null,
      note: usage.note ?? null,
    })
    if (error) {
      console.log(`[${usage.pipeline}] dune usage insert failed (non-fatal): ${error.message}`)
      return false
    }
    return true
  } catch (e) {
    console.log(
      `[${usage.pipeline}] dune usage insert threw (non-fatal): ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
    return false
  }
}
