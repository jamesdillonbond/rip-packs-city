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
 *
 * ── THE CORPSE RULE (2026-09-14) — THIS ARM'S OWN LESSON, APPLIED TO ITSELF ──
 * ⛔ The paragraph above says this arm hands the broken-now-vs-corpse
 * discrimination to "a reader". THERE IS NO READER, and that is now measured.
 * At 07:3x AM PT the arm was amber on five pipelines — fmv-recalc 28/149,
 * drain-fmv-cold-tail 5/48, wmc-fmv-populate 3/293, sentinel 2/30, panini-ingest
 * 1/796 — and EVERY last_kill_at fell inside a 4h16m band on 09-13 (10:12 AM –
 * 2:28 PM PT), the documented IO-saturation spell. Zero kills in the ~17 h since,
 * across hundreds of ticks per lane. So it had been amber for 17 hours on a
 * 4-hour incident that was over, and nobody was going to re-derive five
 * timestamps against five cadences to notice. A permanently-amber instrument is
 * indistinguishable from a broken one, so the discrimination is applied here.
 *
 * ⭐ THE UNIT IS RUNS, NOT HOURS, and that is the whole design. "Hours since the
 * last kill" is a PROXY that coincides today: a lane at 7 ticks/day and one at
 * 796 are not comparable on a clock, and a time rule would clear the slow one on
 * no evidence at all. The property is "has this lane had chances to fail again
 * and taken none", so the measure is CLEAN RUNS SINCE — clean_since_last_kill,
 * which the SQL derives for free because every marker after the last kill is
 * matched by construction (last_kill_at is the MAX unmatched one).
 *
 * ⚠ IT FAILS CLOSED. An offender whose clean_since_last_kill is missing or
 * unreadable counts as LIVE, so an older SQL body that does not return the field
 * keeps warning instead of going green. A failed read must never render as a
 * clean answer — and a "resolved" verdict still NAMES the lanes and their counts,
 * so a finished incident is reported, never silently dropped.
 */

export type WallKillOffender = {
  pipeline?: string
  heartbeats?: number | string | null
  kills?: number | string | null
  kill_pct?: number | string | null
  last_kill_at?: string | null
  /** Consecutive clean ticks since this lane's last kill. Absent => treated as LIVE. */
  clean_since_last_kill?: number | string | null
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
 * @param clearAfter consecutive clean ticks since the last kill before that lane's kills are
 *   treated as a CORPSE rather than a live incident (default 10). Measured in RUNS, never hours —
 *   see the header. A lane too slow to accumulate this many inside the window never clears, which
 *   is the correct conservative answer: there is genuinely no evidence it recovered.
 */
export function summariseWallKills(
  payload: WallKillsPayload | null | undefined,
  warnAt = 3,
  clearAfter = 10,
): WallKillsVerdict {
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

  // ⚠ FAILS CLOSED: an absent or unreadable clean-run count is NOT evidence of
  // recovery, so such a lane stays LIVE. This is what keeps an older SQL body
  // (which returns no such field) warning instead of silently going green.
  const cleanSince = (o: WallKillOffender): number | null => num(o.clean_since_last_kill)
  const isLive = (o: WallKillOffender): boolean => {
    const c = cleanSince(o)
    return c === null || c < clearAfter
  }

  const live = flagged.filter(isLive)
  const resolved = flagged.filter((o) => !isLive(o))

  const describe = (o: WallKillOffender) => {
    const c = cleanSince(o)
    const tail = c === null ? ", clean-run count UNREADABLE" : `, ${c} clean since`
    return `${o.pipeline ?? "unnamed"} ${o.kills}/${o.heartbeats} (${o.kill_pct ?? "?"}%, last ${hhmmPT(o.last_kill_at)}${tail})`
  }
  const list = (arr: WallKillOffender[]) =>
    arr.slice(0, 6).map(describe).join("; ") + (arr.length > 6 ? ` +${arr.length - 6} more` : "")

  // Every flagged lane has since run clean for long enough that the kills in the
  // window are a CORPSE. Still report them by name — a finished incident is
  // reported, not dropped — but do not spend an amber on a condition that is over.
  if (live.length === 0) {
    return {
      status: "ok",
      detail:
        `no LIVE wall kills — ${resolved.length} pipeline(s) reached ${warnAt}+ kills in the window but each has run clean ${clearAfter}+ times since: ` +
        `${list(resolved)} — ${scope}. The window still carries the corpse of a finished incident; measured in RUNS, not hours.`,
      value: totalKills,
    }
  }

  const corpseNote =
    resolved.length > 0
      ? ` (${resolved.length} further pipeline(s) already recovered ${clearAfter}+ clean runs: ${list(resolved)})`
      : ""

  return {
    status: "warn",
    detail:
      `${live.length} pipeline(s) KILLED AT THE WALL ${warnAt}+ times and NOT yet recovered ${clearAfter} clean runs — ` +
      `no terminal row, invisible to every other arm: ${list(live)}${corpseNote} — ${scope}.`,
    value: totalKills,
  }
}
