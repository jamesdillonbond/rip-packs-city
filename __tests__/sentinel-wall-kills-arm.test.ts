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
    expect(v.detail).toContain("fmv-recalc 31/150 (20.7%, last 09:08 PT)")
    // Below the threshold: contributes to the total, is not named as an offender.
    expect(v.detail).not.toContain("panini-ingest")
    expect(v.value).toBe(33)
    // The kill-rate lesson travels with the number.
    expect(v.detail).toMatch(/pooled count cannot tell/)
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
