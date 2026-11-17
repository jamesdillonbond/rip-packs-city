/**
 * A lane that RAN, SUCCEEDED, and FOUND NOTHING — for days.
 *
 * ── WHY (register #79, found via #78 on 2026-09-10) ────────────────────────
 * This platform watches three lane states: *didn't run* (`Pipeline Silence`),
 * *ran and failed* (`ok = false`), *ran and worked*. **There is a fourth, and
 * nothing sees it.** A lane ticking every 15 minutes with `ok = true` and
 * `rows_found = 0` is invisible to silence checks (it is ticking) and to failure
 * checks (it is green).
 *
 * 🚨 That is exactly how `laliga_golazos` listings went **7+ days stale behind
 * ~670 clean-reported runs** while every instrument read OK — and the surfaces
 * kept serving week-old floor asks with nothing anywhere saying otherwise.
 *
 * ── WHY IT IS NOT SIMPLY "ALARM ON ZERO" ───────────────────────────────────
 * ⚠ A sustained zero is genuinely AMBIGUOUS. A finished backfill, or a triage
 * lane that finds no errors, is a **correct** zero — measured: over 14 days with
 * ≥200 runs, `topshot-pack-opens-history-backfill`, `ufc-stub-thumbnail-resolver`,
 * `pack-pull-source-rip-id-backfill` and `refresh-error-triage` all read
 * `found = 0, written = 0` and are all fine.
 *
 * ⭐ So the SQL side keys on a **FALL, not a level**: the lane's own history is
 * its declaration — it must have HAD a non-zero baseline and since gone to zero
 * while still running. That needs no per-lane configuration for ~140 lanes, and
 * shrinks the curated part to a **suppression** list, which is this repo's
 * prescribed guard shape. ⚠ It also sidesteps a trap: `allday-badge-low-ask-refresh`
 * and `golazos-badge-low-ask-refresh` read `found = 0` while writing 695,692 and
 * 8,541 rows — they never populate `rows_found` at all, so a level-based rule
 * would flag two healthy lanes forever.
 *
 * ⚠ THE ARM WARNS, IT DOES NOT PAGE. These are CANDIDATES: on the first live run
 * two of the five are named `*backfill`. Calling them CRITICAL would spend the
 * loudest signal this estate has on a lane that may have simply finished.
 */

export type ZeroYieldOffender = {
  pipeline?: string
  found_baseline?: number | string | null
  runs_recent?: number | string | null
  written_recent?: number | string | null
  last_find?: string | null
}

export type ZeroYieldPayload = {
  inspected?: unknown
  suppressed?: unknown
  offenders?: unknown
  window?: { baseline_days?: number; zero_days?: number; min_runs?: number }
}

export type ZeroYieldVerdict = { status: "ok" | "warn" | "critical"; detail: string }

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

export function summariseZeroYield(payload: ZeroYieldPayload | null | undefined): ZeroYieldVerdict {
  if (!payload || typeof payload !== "object") {
    // A missing payload is not a clean result. The caller owns the query-error
    // branch; this is the "it returned something unreadable" case.
    return { status: "warn", detail: "check_zero_yield_lanes returned no readable payload — UNMEASURED, not clean" }
  }

  const inspected = num(payload.inspected)
  // ⚠ A run that inspected NOTHING must not read as a run that found nothing.
  // The population is the first thing checked, not a footnote — this repo has
  // shipped a guard that walked an empty tree and exited 0.
  if (inspected === null || inspected <= 0) {
    return {
      status: "warn",
      detail: `check_zero_yield_lanes inspected ${inspected ?? "an unreadable number of"} lanes — a verdict from zero lanes is not a verdict`,
    }
  }

  const suppressed = num(payload.suppressed) ?? 0
  const offenders = Array.isArray(payload.offenders) ? (payload.offenders as ZeroYieldOffender[]) : []
  const w = payload.window ?? {}
  const windowText = `${w.zero_days ?? "?"}d zero / ${w.baseline_days ?? "?"}d baseline / ≥${w.min_runs ?? "?"} runs`
  // Suppression is REPORTED, never silent — a guard that hides what it excluded
  // makes its own incidence unmeasurable.
  const scope = `${inspected} lanes inspected, ${suppressed} suppressed (${windowText})`

  if (offenders.length === 0) return { status: "ok", detail: `no lane has fallen to zero yield — ${scope}` }

  const named = offenders
    .slice(0, 6)
    .map((o) => {
      const runs = o.runs_recent ?? "?"
      const last = o.last_find ?? "never"
      return `${o.pipeline ?? "unnamed"} (${runs} runs, last find ${last})`
    })
    .join("; ")
  const more = offenders.length > 6 ? ` +${offenders.length - 6} more` : ""

  return {
    status: "warn",
    detail: `${offenders.length} lane(s) ran clean and found NOTHING: ${named}${more} — ${scope}`,
  }
}
