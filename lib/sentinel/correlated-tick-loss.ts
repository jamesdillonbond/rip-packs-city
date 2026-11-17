/**
 * A fleet dip that no per-pipeline arm can see.
 *
 * ── WHY (register R77, filed 2026-09-03) ───────────────────────────────────
 * On 2026-09-01, 28 then 16 clock-driven pipelines each missed a tick inside
 * one two-hour band and nothing alerted: every gap was shorter than that lane's
 * own `max_silent_minutes`, so `Pipeline Silence` and `detect_stalled_pipelines`
 * stayed quiet. Each arm here is per pipeline; a dip small per lane and large
 * across the fleet is invisible to all of them by construction.
 *
 * `check_correlated_tick_loss()` (migration 20261003191353) returns, per hour a
 * tick was DUE, the count of DISTINCT clock-driven pipelines that missed one.
 * This module turns the worst hour into a verdict.
 *
 * ── THE THRESHOLD IS CALIBRATED (sentinel_threshold_config, warn_at 10) ────
 * Quiet windows: max 5 per hour (08-31..09-03), max 3 (09-30..10-03, 132 clock
 * pipelines, 70 h). Real events: 16 and 28 (09-01), 116 (09-18, #122).
 *
 * ⚠ IT WARNS, NEVER CRITICAL: a miss is only knowable once the next run lands,
 * so this is a post-hoc report of a dip, not a live outage detector — that is
 * `Pipeline Silence`'s job.
 * ⚠ A payload it cannot read is UNMEASURED, never clean.
 */

export const CORRELATED_TICK_LOSS_CHECK_NAME = "Correlated Tick Loss"
export const CORRELATED_TICK_LOSS_DEFAULT_WARN_AT = 10

export type TickLossHour = {
  due_hour?: string | null
  pipelines?: number | null
  ticks?: number | null
  sample?: string[] | null
}

export type TickLossPayload = {
  clock_pipelines?: number | null
  recent?: string | null
  hours?: TickLossHour[] | null
}

export type TickLossVerdict = { status: "ok" | "warn"; detail: string; value?: number }

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

export function summariseCorrelatedTickLoss(
  payload: TickLossPayload | null | undefined,
  warnAt: number,
  formatTime: (iso: string | null) => string,
): TickLossVerdict {
  const clock = num(payload?.clock_pipelines)
  if (!payload || typeof payload !== "object" || clock === null || !Array.isArray(payload.hours)) {
    return {
      status: "warn",
      detail: "check_correlated_tick_loss returned no readable payload — UNMEASURED, not clean",
    }
  }
  if (clock === 0) {
    // No pipeline qualifies as clock-driven: the instrument has no population,
    // which is a broken read of pipeline_runs, not a quiet fleet.
    return {
      status: "warn",
      detail: "0 pipelines qualified as clock-driven in the history window — the population is empty, so this is UNMEASURED, not clean",
    }
  }

  const hours = payload.hours
    .map((h) => ({ ...h, n: num(h?.pipelines) ?? 0 }))
    .sort((a, b) => b.n - a.n)
  const worst = hours[0]
  const worstN = worst?.n ?? 0
  const window = payload.recent ?? "the recent window"

  if (worst && worstN >= warnAt) {
    const sample = Array.isArray(worst.sample) ? worst.sample.slice(0, 6).join(", ") : ""
    const ticks = num(worst.ticks)
    return {
      status: "warn",
      value: worstN,
      detail:
        `${worstN} of ${clock} clock-driven pipelines missed a tick due in the hour from ${formatTime(worst.due_hour ?? null)}` +
        `${ticks !== null ? ` (${ticks} ticks)` : ""} — a correlated dip, below every lane's own silence limit. ` +
        `Threshold ${warnAt}; quiet hours run 0–5. ${sample ? `Includes: ${sample}.` : ""}`.trim(),
    }
  }
  return {
    status: "ok",
    value: worstN,
    detail: `worst hour in the last ${window}: ${worstN} of ${clock} clock-driven pipelines missed a tick (warns at ${warnAt})`,
  }
}
