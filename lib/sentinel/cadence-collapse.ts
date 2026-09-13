/**
 * A lane that is still RUNNING and still GREEN, at a fraction of its own cadence.
 *
 * ── WHY (register #76 / #80, wired 2026-09-12) ─────────────────────────────
 * On 2026-09-10 a Vercel spend-cap pause made nine cron-job.org entries fail
 * enough times in a row that cron-job.org AUTO-DISABLED them. The site came
 * back; the entries did not. For **two days** those nine lanes — including
 * BOTH user-facing alert lanes — ran at 4–12 % of their cadence off whatever
 * else still called them, and every instrument in the estate read fine:
 *   · `Pipeline Silence` — a lane ticking at 8/day is not silent.
 *   · `Pipeline Success`  — every run that did happen was `ok = true`.
 *   · `Zero-Yield Lanes`  — they wrote rows; there was nothing wrong with the rows.
 * 🚨 The user-facing cost was measured on the way out: `alert_deliveries`
 * latency went 0.0 min → 10.0 → 35.7 → **289.5 min** across those four days.
 * A price alert delivered 4.8 hours late is worthless to a sniper product.
 *
 * ⭐ The state this names is *degraded cadence*: RUNNING, SUCCEEDING, and far
 * below the rate the lane's own history says it keeps. `check_pipeline_cadence_collapse()`
 * measures it (observed/day over a 12 h window ÷ the lane's own median/day over
 * a 14 d baseline that deliberately excludes the last 3 days) so no per-lane
 * configuration is needed for ~100 lanes.
 *
 * ── THE TWO DELIBERATE NARROWINGS ──────────────────────────────────────────
 * ⛔ **`stopped` IS REPORTED AS CONTEXT AND NEVER SCORED.** The four lanes it
 * names today (`compute-topshot-pack-ev`, `offers-sweep`, `topshot-moments-hydrator`,
 * `topshot-pack-pool-backfill`) are each covered by a REGISTERED, DECIDED
 * disposition (#50, #21, #38, and `offers-sweep`'s deliberate retirement).
 * Scoring them would make this arm permanently red on day one, which is exactly
 * the #25 trap this estate keeps paying for — and a stopped lane is `Pipeline
 * Silence`'s job, not this one's. **This arm exists for the state nothing else sees.**
 *
 * ⚠ **ONE DEGRADED LANE WARNS; A FLEET OF THEM PAGES.** A single lane drifting
 * is a lane problem. Five at once is a CALLER problem — a scheduler, a budget, a
 * console — which is the class that produced both #76 and #80, and the class a
 * human has to act on tonight rather than tomorrow. Both edges are configurable
 * through `sentinel_threshold_config` (`warn_at` / `crit_at`), so the split can
 * be retuned from the database without a deploy.
 */

export type CadenceOffender = {
  pipeline?: string
  ratio?: number | string | null
  observed_per_day?: number | string | null
  baseline_per_day?: number | string | null
  last_run_at?: string | null
}

export type CadenceCollapsePayload = {
  inspected?: unknown
  excluded_heartbeats?: unknown
  degraded?: unknown
  stopped?: unknown
  window?: { window_hours?: number; baseline_days?: number; ratio?: number | string; exclude_days?: number }
}

export type CadenceVerdict = { status: "ok" | "warn" | "critical"; detail: string; value?: number }

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v
  // The RPC returns numeric columns as strings through PostgREST for anything
  // wider than a float, so a string that parses is a real number here.
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v)
  return null
}

const pct = (v: unknown): string => {
  const n = num(v)
  return n === null ? "?" : `${Math.round(n * 100)}%`
}

export function summariseCadenceCollapse(
  payload: CadenceCollapsePayload | null | undefined,
  warnAt = 1,
  critAt = 5,
): CadenceVerdict {
  if (!payload || typeof payload !== "object") {
    return {
      status: "warn",
      detail:
        "check_pipeline_cadence_collapse returned no readable payload — UNMEASURED, not clean",
    }
  }

  // ⚠ A verdict from zero lanes is not a verdict. Same rule as the zero-yield
  // arm: the POPULATION is checked before the finding, because this estate has
  // shipped a guard that walked an empty tree and exited 0.
  const inspected = num(payload.inspected)
  if (inspected === null || inspected <= 0) {
    return {
      status: "warn",
      detail: `check_pipeline_cadence_collapse inspected ${inspected ?? "an unreadable number of"} lanes — a verdict from zero lanes is not a verdict`,
    }
  }

  const degraded = Array.isArray(payload.degraded) ? (payload.degraded as CadenceOffender[]) : []
  const stoppedCount = Array.isArray(payload.stopped) ? payload.stopped.length : 0
  const w = payload.window ?? {}
  const scope = `${inspected} lanes inspected, ${num(payload.excluded_heartbeats) ?? 0} heartbeats excluded, ${stoppedCount} stopped (not scored — see Pipeline Silence) · ${w.window_hours ?? "?"}h vs ${w.baseline_days ?? "?"}d baseline at ratio ${w.ratio ?? "?"}`

  if (degraded.length < Math.max(1, warnAt)) {
    return { status: "ok", detail: `no lane is running below its own cadence — ${scope}`, value: degraded.length }
  }

  // Worst first, so the six that fit in a Telegram message are the six worth reading.
  const ordered = [...degraded].sort((a, b) => (num(a.ratio) ?? 1) - (num(b.ratio) ?? 1))
  const named = ordered
    .slice(0, 6)
    .map((o) => `${o.pipeline ?? "unnamed"} at ${pct(o.ratio)} of baseline (${num(o.observed_per_day) ?? "?"}/day vs ${num(o.baseline_per_day) ?? "?"})`)
    .join("; ")
  const more = ordered.length > 6 ? ` +${ordered.length - 6} more` : ""

  const status = degraded.length >= critAt ? "critical" : "warn"
  const lead =
    status === "critical"
      ? `${degraded.length} lanes are running FAR below their own cadence — that many at once is a CALLER fault (scheduler / budget / console), not ${degraded.length} lane faults`
      : `${degraded.length} lane(s) running below their own cadence`

  return { status, detail: `${lead}: ${named}${more} — ${scope}`, value: degraded.length }
}
