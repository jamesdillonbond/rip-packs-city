/**
 * A pg_cron job that fails EVERY run — as a sentinel arm.
 *
 * ── WHY (2026-11-22) ────────────────────────────────────────────────────────
 * `rpc-portfolio-snapshot-packs` (pg_cron 901) shipped 11-21 and FAILED both of its
 * runs (`invalid transaction termination` — a `SET …;` prefix made its CALL a
 * transaction block). 0 of 58 portfolio snapshots got a pack value, and nothing
 * said so: the fleet-level `pg_cron Failures (6h)` arm fires at ≥ 10 failures in
 * 6 h across the instance, and a twice-a-day job failing every run contributes 1
 * per window. `check_pgcron_recent_failures()` named it correctly — and had no
 * caller that alerts. The 11-22 overnight pass did not see it either.
 *
 * ── WHAT IT FLAGS ───────────────────────────────────────────────────────────
 * From `check_pgcron_recent_failures(p_window)` — jobs whose LATEST run failed —
 * the ones whose EVERY run in the window failed, with at least `minRuns` runs.
 * The window is 48 h so a daily job that fails twice in a row is caught; a job
 * whose period exceeds the window, or that ran once, cannot be told apart from a
 * one-off and is not flagged (it stays visible to the fleet arm).
 * An intermittent job (latest failed, some succeeded) is not this arm's question.
 *
 * ── WHY IT WARNS AND NEVER PAGES ────────────────────────────────────────────
 * A job that never succeeds is real and silent, but it is a lane defect for a
 * human to read, not a 3 am incident. An unreadable payload is UNMEASURED, never
 * clean: a failed read must not render as "no failing jobs".
 */

export type CronFailingRow = {
  jobname?: string | null
  latest_status?: string | null
  last_run?: string | null
  fails_in_window?: number | string | null
  runs_in_window?: number | string | null
  last_fail_message?: string | null
}

export type CronFailingVerdict = { status: "ok" | "warn"; detail: string; value?: number }

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN
  return Number.isFinite(n) ? n : null
}

export function summariseCronJobsFailing(
  payload: unknown,
  windowLabel = "48h",
  minRuns = 2,
): CronFailingVerdict {
  if (!Array.isArray(payload)) {
    return {
      status: "warn",
      detail:
        "UNMEASURED — check_pgcron_recent_failures returned no readable rows, so jobs failing " +
        "every run were not evaluated. This is an unreadable result, not zero failing jobs.",
    }
  }
  const always: Array<{ name: string; runs: number; msg: string }> = []
  for (const r of payload as CronFailingRow[]) {
    if (!r || typeof r !== "object") continue
    const runs = num(r.runs_in_window)
    const fails = num(r.fails_in_window)
    if (runs == null || fails == null) continue
    if (r.latest_status !== "failed" || runs < minRuns || fails < runs) continue
    const msg = String(r.last_fail_message ?? "")
      .replace(/\s+/g, " ")
      .replace(/^ERROR:\s*/, "")
      .slice(0, 90)
    always.push({ name: String(r.jobname ?? "?"), runs, msg })
  }
  if (always.length === 0) {
    return {
      status: "ok",
      detail: `0 pg_cron jobs failed every run in ${windowLabel} (${payload.length} with a failed latest run).`,
      value: 0,
    }
  }
  always.sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name))
  const list = always
    .slice(0, 5)
    .map((j) => `${j.name} (${j.runs}/${j.runs} failed: ${j.msg})`)
    .join("; ")
  const more = always.length > 5 ? ` …and ${always.length - 5} more` : ""
  return {
    status: "warn",
    detail:
      `${always.length} pg_cron job(s) failed EVERY run in ${windowLabel} — a lane that never ` +
      `succeeds: ${list}${more}. Read the job's command and return_message before anything else.`,
    value: always.length,
  }
}
