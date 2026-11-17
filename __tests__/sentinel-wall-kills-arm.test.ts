import { describe, it, expect } from "vitest"
import { summariseWallKills } from "@/lib/sentinel/wall-kills"

// The arm for the state apply-fmv-haircut was in on 2026-09-12: STARTED (a
// marker row), never FINISHED (no terminal row), and seen by nothing that pages
// until the 30 h silence arm a day later. lib/sentinel/wall-kills.ts carries
// the argument; these pin the contract.

const healthy = (over: Record<string, unknown> = {}) => ({
  inspected: 45,
  verified: 44,
  unverified: [{ pipeline: "dead-lane-backstop", heartbeats: 7 }],
  window: { hours: 24, grace_minutes: 10, correlation_seconds: 5 },
  offenders: [],
  ...over,
})
const offender = (pipeline: string, kills: number, heartbeats = 150) => ({
  pipeline,
  heartbeats,
  kills,
  kill_pct: Math.round((1000 * kills) / heartbeats) / 10,
  last_kill_at: "2026-09-13T16:08:05Z",
})

describe("summariseWallKills — the population comes before the finding", () => {
  it("an unreadable payload is UNMEASURED, never clean", () => {
    for (const bad of [null, undefined, "nope" as any, 7 as any]) {
      const v = summariseWallKills(bad)
      expect(v.status).toBe("warn")
      expect(v.detail).toMatch(/UNMEASURED/)
    }
  })

  it("⚠ inspecting ZERO heartbeated pipelines is not a clean bill of health", () => {
    for (const inspected of [0, -1, null, "x"]) {
      const v = summariseWallKills(healthy({ inspected }))
      expect(v.status).toBe("warn")
      expect(v.detail).toMatch(/zero markers is not a verdict/)
    }
  })

  it("is ok when no pipeline reaches the warn count, and still names the scope and the sub-threshold kills", () => {
    const v = summariseWallKills(healthy({ offenders: [offender("evm-transfers-ingest", 1, 143)] }))
    expect(v.status).toBe("ok")
    expect(v.detail).toContain("45 heartbeated pipelines")
    expect(v.detail).toContain("1 unverified")
    expect(v.detail).toContain("fewer than 3 kills (1 total)")
    expect(v.value).toBe(1)
  })

  it("warns on a pipeline killed warnAt+ times, naming count, share and the LAST kill in PT", () => {
    const v = summariseWallKills(healthy({ offenders: [offender("fmv-recalc", 31, 150), offender("panini-ingest", 2, 789)] }))
    expect(v.status).toBe("warn")
    expect(v.detail).toContain("1 pipeline(s) KILLED AT THE WALL")
    // Pin the SUBSTANCE (lane, counts, share, last kill in PT), not the exact
    // parenthetical — the corpse rule appends a clean-run clause to this string.
    expect(v.detail).toContain("fmv-recalc 31/150 (20.7%, last 09:08 PT")
    // Below the threshold: contributes to the total, is not named as an offender.
    expect(v.detail).not.toContain("panini-ingest")
    expect(v.value).toBe(33)
    // ⭐ INVERTED 2026-09-14, not deleted. This used to assert the detail NARRATED
    // the kill-rate lesson ("a pooled count cannot tell broken-now from corpse")
    // and handed the discrimination to a reader. The arm now APPLIES it, so the
    // promise this test held is kept by the verdict itself: a warn must say the
    // lane has not recovered, which is a claim a pooled count could not make.
    expect(v.detail).toMatch(/NOT yet recovered \d+ clean runs/)
  })

  it("honours a configured warn count", () => {
    expect(summariseWallKills(healthy({ offenders: [offender("x", 2)] }), 2).status).toBe("warn")
    expect(summariseWallKills(healthy({ offenders: [offender("x", 2)] }), 3).status).toBe("ok")
  })

  it("never pages: these are candidates, not incidents", () => {
    const many = Array.from({ length: 12 }, (_, i) => offender(`lane-${i}`, 50, 60))
    const v = summariseWallKills(healthy({ offenders: many }))
    expect(v.status).toBe("warn")
    expect(v.detail).toContain("+6 more")
  })

  it("tolerates numeric strings from jsonb", () => {
    const v = summariseWallKills({ inspected: "45", verified: "44", unverified: [], window: {}, offenders: [offender("a", "3" as any)] })
    expect(v.status).toBe("warn")
  })
})

// ── THE CORPSE RULE (2026-09-14) ───────────────────────────────────────────
// Measured that day: all five flagged lanes' last_kill_at fell inside a 4h16m
// band on 09-13 and there had been ZERO kills in the ~17 h since — the arm was
// amber for 17 hours on an incident that was over. These pin BOTH directions,
// because an arm that can only go quiet is as useless as one that can only warn.
const withClean = (pipeline: string, kills: number, cleanSince: number | null | undefined, heartbeats = 150) => {
  const o: Record<string, unknown> = {
    pipeline,
    heartbeats,
    kills,
    kill_pct: Math.round((1000 * kills) / heartbeats) / 10,
    last_kill_at: "2026-09-13T16:08:05Z",
  }
  if (cleanSince !== undefined) o.clean_since_last_kill = cleanSince
  return o
}

describe("summariseWallKills — a corpse in the window is not a live incident", () => {
  it("⭐ clears when every flagged lane has run clean past the threshold — the 09-14 case", () => {
    const v = summariseWallKills(healthy({ offenders: [withClean("fmv-recalc", 28, 106, 149)] }))
    expect(v.status).toBe("ok")
    // ⚠ Cleared is NOT dropped: the lane, its counts and its clean run are all still named.
    expect(v.detail).toContain("fmv-recalc")
    expect(v.detail).toContain("28/149")
    expect(v.detail).toContain("106 clean since")
    expect(v.detail).toMatch(/no LIVE wall kills/)
    expect(v.value).toBe(28)
  })

  it("🚨 still WARNS while the lane has not recovered — proving the watcher can see a failure", () => {
    const v = summariseWallKills(healthy({ offenders: [withClean("fmv-recalc", 28, 2, 149)] }))
    expect(v.status).toBe("warn")
    expect(v.detail).toContain("NOT yet recovered")
    expect(v.detail).toContain("2 clean since")
  })

  it("⚠ FAILS CLOSED — an absent clean-run count is LIVE, never a clean bill of health", () => {
    // This is what keeps an OLDER SQL body (which returns no such field) warning
    // instead of silently going green the moment it is deployed against new TS.
    const v = summariseWallKills(healthy({ offenders: [withClean("fmv-recalc", 28, undefined, 149)] }))
    expect(v.status).toBe("warn")
    expect(v.detail).toContain("UNREADABLE")
  })

  it("⚠ an UNPARSEABLE clean-run count is LIVE too — not coerced to zero or to a pass", () => {
    for (const junk of ["", "  ", "n/a", null]) {
      const v = summariseWallKills(healthy({ offenders: [withClean("fmv-recalc", 28, junk as never, 149)] }))
      expect(v.status).toBe("warn")
      expect(v.detail).toContain("UNREADABLE")
    }
  })

  it("a lane too slow to accumulate the threshold stays flagged — no evidence is not recovery", () => {
    // dead-lane-backstop shape: 7 ticks/day. 5 clean runs is all it could manage,
    // and a TIME-based rule would have cleared it on the clock alone. It must not.
    const v = summariseWallKills(healthy({ offenders: [withClean("dead-lane-backstop", 3, 5, 7)] }))
    expect(v.status).toBe("warn")
  })

  it("mixed fleet: one live lane warns, and the recovered ones are still reported alongside", () => {
    const v = summariseWallKills(
      healthy({ offenders: [withClean("fmv-recalc", 28, 1, 149), withClean("panini-ingest", 12, 400, 796)] }),
    )
    expect(v.status).toBe("warn")
    expect(v.detail).toContain("1 pipeline(s) KILLED AT THE WALL")
    expect(v.detail).toContain("fmv-recalc")
    // The corpse is named as already-recovered rather than counted as an offender.
    expect(v.detail).toContain("already recovered")
    expect(v.detail).toContain("panini-ingest")
    expect(v.value).toBe(40) // value stays the WINDOW total, live + corpse
  })

  it("honours a configured clearAfter in both directions", () => {
    const o = [withClean("fmv-recalc", 28, 6, 149)]
    expect(summariseWallKills(healthy({ offenders: o }), 3, 5).status).toBe("ok")
    expect(summariseWallKills(healthy({ offenders: o }), 3, 20).status).toBe("warn")
  })

  it("a lane below warnAt is never resurrected by the corpse rule", () => {
    // Sub-threshold kills were never offenders; adding recency must not change that.
    const v = summariseWallKills(healthy({ offenders: [withClean("panini-ingest", 1, 0, 796)] }))
    expect(v.status).toBe("ok")
    expect(v.detail).toMatch(/fewer than 3 kills/)
  })

  it("tolerates a numeric-string clean-run count from jsonb", () => {
    const v = summariseWallKills(healthy({ offenders: [withClean("fmv-recalc", 28, "106" as never, 149)] }))
    expect(v.status).toBe("ok")
  })
})
