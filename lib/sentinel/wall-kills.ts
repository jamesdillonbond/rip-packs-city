/**
 * A lane that STARTED and never FINISHED — the `maxDuration` kill, as a sentinel arm.
 *
 * ── WHY (2026-09-13) ────────────────────────────────────────────────────────
 * `lib/pipeline/heartbeat.ts` explains the mechanism: a platform kill at the
 * route's wall runs neither the success path nor the catch, so NO terminal
 * `pipeline_runs` row is written. Every summary instrument on this platform
 * reads terminal rows, so a killed tick is invisible to all of them — in
 * `pipeline_runs_daily` it is not even a failure, it is a MISSING TICK, and the
 * lifetime record reads 100% ok.
 *
 * The correlation that sees it (a marker row with no terminal row within ±5 s)
 * existed only as an operator script, `npm run pipelines:kills`, which nobody
 * runs on a schedule. Measured the day this shipped: `apply-fmv-haircut` was
 * killed at 300 s on 09-12 15:35 PT and the first instrument to notice was the
 * 30-hour SILENCE arm, a day later — and that lane had no heartbeat at all. The
 * same 24 h window held 31 kills on `fmv-recalc` (of 150 ticks), 26 on
 * `panini-ingest` (of 789), 24 on `wallet-backfill` (of 735), 11 on
 * `drain-fmv-cold-tail` (of 46): every one recorded by nothing that pages.
 *
 * ── WHAT THE SQL SIDE DOES, AND THE TWO RULES IT BORROWS ────────────────────
 * `check_wall_kills(window, grace)` mirrors `lib/pipeline/kill-rate.ts`:
 *   • a `-heartbeat` row is a marker for its base name; a `-dispatch` row is a
 *     marker ONLY when a `-complete` sibling exists in the window (a name that
 *     merely ends in `-dispatch`, like `alerts-dispatch`, is a real pipeline);
 *   • a marker is MATCHED when a terminal row for the base (or `-complete`)
 *     starts within ±5 s of it; an unmatched marker is a kill;
 *   • markers younger than `grace` are excluded — an invocation still running
 *     has no terminal row yet and is not a kill.
 *
 * ⭐ AND ONE RULE OF ITS OWN: a pipeline whose markers NEVER match — zero
 * terminal rows in the whole window — is not scored as 100% killed. It is
 * reported as `unverified`: a marker with no writer to correlate against is
 * unproven, not dead. Measured live, `dead-lane-backstop` writes a GHA-side
 * heartbeat and by design never a terminal row; scoring it would invent a
 * permanently-100%-killed pipeline out of a healthy workflow.
 *
 * ── WHY IT WARNS AND DOES NOT PAGE ──────────────────────────────────────────
 * The kill-rate module's central lesson is that a POOLED rate over a window
 * cannot distinguish "broken now" from "was broken, then fixed, and the window
 * still carries the corpse". This arm reports the window's count and the LAST
 * kill time so a reader can apply that discrimination; it does not pretend to
 * apply it itself. Candidates, like the zero-yield arm — and, like it, the first
 * live reading names five pipelines, so `critical` here would spend the loudest
 * signal this estate has on lanes that may be clipping a tail by design.
 */

export type WallKillOffender = {
  pipeline?: string
  heartbeats?: number | string | null
  kills?: number | string | null
  kill_pct?: number | string | null
  last_kill_at?: string | null
}

export type WallKillsPayload = {
  inspected?: unknown
  verified?: unknown
  unverified?: unknown
  offenders?: unknown
  window?: { hours?: number | string; grace_minutes?: number | string; correlation_seconds?: number | string }
}

export type WallKillsVerdict = { status: "ok" | "warn" | "critical"; detail: string; value?: number }

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v)
  return null
}

function hhmmPT(iso: string | null | undefined): string {
  if (!iso) return "?"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "?"
  return d.toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hour12: false }) + " PT"
}

/**
 * @param warnAt a pipeline with at least this many kills in the window is an offender (default 3:
 *   one kill is a clipped tail, two can be a coincidence, three in a day is a pattern).
 */
export function summariseWallKills(payload: WallKillsPayload | null | undefined, warnAt = 3): WallKillsVerdict {
  if (!payload || typeof payload !== "object") {
    // An unreadable payload is not a clean result. The caller owns the
    // query-error branch; this is "it returned something unreadable".
    return { status: "warn", detail: "check_wall_kills returned no readable payload — UNMEASURED, not clean" }
  }

  const inspected = num(payload.inspected)
  // ⚠ A run that inspected NOTHING must not read as a run that found nothing.
  // The fleet has ~45 heartbeated pipelines; zero means the markers stopped
  // being written or the query broke, and both are findings.
  if (inspected === null || inspected <= 0) {
    return {
      status: "warn",
      detail: `check_wall_kills inspected ${inspected ?? "an unreadable number of"} heartbeated pipelines — a verdict from zero markers is not a verdict`,
    }
  }

  const verified = num(payload.verified) ?? 0
  const unverified = Array.isArray(payload.unverified) ? payload.unverified.length : 0
  const offenders = Array.isArray(payload.offenders) ? (payload.offenders as WallKillOffender[]) : []
  const w = payload.window ?? {}
  const scope =
    `${inspected} heartbeated pipelines, ${verified} with a terminal writer, ${unverified} unverified ` +
    `(${w.hours ?? "?"}h window, ±${w.correlation_seconds ?? "?"}s correlation, ${w.grace_minutes ?? "?"}m grace)`

  const flagged = offenders.filter((o) => (num(o.kills) ?? 0) >= warnAt)
  const totalKills = offenders.reduce((s, o) => s + (num(o.kills) ?? 0), 0)

  if (flagged.length === 0) {
    const under = offenders.length > 0 ? `; ${offenders.length} pipeline(s) with fewer than ${warnAt} kills (${totalKills} total)` : ""
    return { status: "ok", detail: `no pipeline killed at its wall ${warnAt}+ times — ${scope}${under}`, value: totalKills }
  }

  const named = flagged
    .slice(0, 6)
    .map((o) => `${o.pipeline ?? "unnamed"} ${o.kills}/${o.heartbeats} (${o.kill_pct ?? "?"}%, last ${hhmmPT(o.last_kill_at)})`)
    .join("; ")
  const more = flagged.length > 6 ? ` +${flagged.length - 6} more` : ""

  return {
    status: "warn",
    detail:
      `${flagged.length} pipeline(s) KILLED AT THE WALL ${warnAt}+ times — no terminal row, invisible to every other arm: ` +
      `${named}${more} — ${scope}. Read the LAST kill time before calling it live: a pooled count cannot tell "broken now" from "fixed, corpse still in the window".`,
    value: totalKills,
  }
}
