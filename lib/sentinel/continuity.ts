/**
 * The sentinel's own blind window — the one outage no other arm can report.
 *
 * ── WHY (register R77, 2026-10-03) ─────────────────────────────────────────
 * During the 2026-09-18 outage (#122) the sentinel was invoked and died at its
 * wall on every tick for seven hours. When the database came back, the first
 * sweep reported `cron_silent` / `cursor_stalled` on lanes that had already
 * recovered — and nothing said "the ALARM ITSELF was blind from 5:04 AM to
 * 12:04 PM PT". Every other arm measures the fleet; none measures the gap in
 * the measurer, and a lane that broke and recovered inside that gap is seen by
 * nobody.
 *
 * This arm reads the start time of the last sweep the ROUTE completed (runner
 * rows written by `pipeline-sentinel.yml` on unreachability are skipped by the
 * caller — they record that the route did NOT complete) and reports the gap.
 *
 * ── THE THRESHOLD IS MEASURED, NOT CHOSEN ──────────────────────────────────
 * cron-job.org calls this route hourly in ack mode, plus GitHub's shed ~6/day.
 * Measured 2026-10-03 over the 86 completed sweeps in retention (09-30 →
 * 10-03): p50 gap 59.99 min, p99 60.02, MAX 60.02, zero gaps over 90 min. So a
 * gap over 150 minutes means at least two consecutive hourly sweeps failed to
 * complete — never a jittered tick. Re-derive if the caller's cadence moves.
 *
 * ⚠ IT WARNS, IT DOES NOT PAGE CRITICAL. It is a RECOVERY report: by the time it
 * can fire, the blind window has already closed. Its value is dating that window
 * so the reader knows which hours nobody watched.
 * ⚠ An unreadable previous sweep is UNMEASURED, never "continuous" — the
 * three-state rule: read failed ≠ read ok and fine.
 */

export const CONTINUITY_CHECK_NAME = "Alarm Continuity"
export const CONTINUITY_GAP_WARN_MIN = 150

export type ContinuityPrevious =
  | { ok: true; at: string | null }
  // A row was read but its check names were unusable: the start time still is.
  | { ok: false; reason: string; at?: string | null }

export type ContinuityVerdict = {
  status: "ok" | "warn"
  detail: string
  value?: number
}

function span(min: number): string {
  const h = Math.floor(min / 60)
  const m = Math.round(min - h * 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export function summariseContinuity(
  previous: ContinuityPrevious,
  nowIso: string,
  formatTime: (iso: string | null) => string,
  thresholdMin: number = CONTINUITY_GAP_WARN_MIN,
): ContinuityVerdict {
  if (!previous.ok && !previous.at) {
    return {
      status: "warn",
      detail: `UNMEASURED — could not read the previous completed sweep (${previous.reason}), so whether this alarm was blind before this run is unknown, not fine`,
    }
  }
  const prevMs = previous.at ? Date.parse(previous.at) : NaN
  const nowMs = Date.parse(nowIso)
  if (!Number.isFinite(prevMs) || !Number.isFinite(nowMs)) {
    return {
      status: "warn",
      detail: "UNMEASURED — the previous completed sweep carries no readable start time",
    }
  }
  const gapMin = Math.max(0, (nowMs - prevMs) / 60_000)
  const rounded = Math.round(gapMin)
  if (gapMin > thresholdMin) {
    return {
      status: "warn",
      value: rounded,
      detail:
        `THIS ALARM WAS BLIND for ${span(gapMin)}: no sweep completed between ${formatTime(previous.at ?? null)} and ` +
        `${formatTime(nowIso)} (threshold ${thresholdMin}m; normal cadence is hourly). ` +
        `Anything that broke and recovered inside that window was not seen by the sentinel — ` +
        `read pipeline_runs for those hours before treating this sweep as the whole story.`,
    }
  }
  return {
    status: "ok",
    value: rounded,
    detail: `previous completed sweep ${span(gapMin)} ago (warns past ${thresholdMin}m)`,
  }
}
