import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { summariseCadenceCollapse } from "@/lib/sentinel/cadence-collapse"

// The arm for the state #76 lived in for two days: lanes RUNNING, GREEN, and at
// 4–12 % of their own cadence, invisible to silence checks (they were ticking),
// to failure checks (they were ok) and to the zero-yield arm (they wrote rows).

const healthy = (over: Record<string, unknown> = {}) => ({
  inspected: 98,
  excluded_heartbeats: 46,
  window: { window_hours: 12, baseline_days: 14, ratio: 0.4, exclude_days: 3 },
  degraded: [],
  stopped: [],
  ...over,
})

const lane = (pipeline: string, ratio: number) => ({
  pipeline,
  ratio,
  observed_per_day: 10,
  baseline_per_day: Math.round(10 / ratio),
  last_run_at: "2026-09-12T20:00:00Z",
})

describe("summariseCadenceCollapse — the population comes before the finding", () => {
  it("an unreadable payload is UNMEASURED, never clean", () => {
    for (const bad of [null, undefined, "nope" as any, 7 as any]) {
      const v = summariseCadenceCollapse(bad)
      expect(v.status).toBe("warn")
      expect(v.detail).toMatch(/UNMEASURED/)
    }
  })

  it("⚠ inspecting ZERO lanes is not a clean bill of health", () => {
    for (const n of [0, -1, undefined, "many" as any]) {
      const v = summariseCadenceCollapse(healthy({ inspected: n }))
      expect(v.status).toBe("warn")
      expect(v.detail).toMatch(/not a verdict/)
    }
  })

  it("a real population with nothing degraded is ok, and says what it looked at", () => {
    const v = summariseCadenceCollapse(healthy())
    expect(v.status).toBe("ok")
    expect(v.value).toBe(0)
    expect(v.detail).toContain("98 lanes inspected")
    expect(v.detail).toContain("46 heartbeats excluded")
  })
})

describe("summariseCadenceCollapse — one lane warns, a fleet pages", () => {
  it("a single degraded lane is a WARN, not a page", () => {
    const v = summariseCadenceCollapse(healthy({ degraded: [lane("alerts-send", 0.069)] }))
    expect(v.status).toBe("warn")
    expect(v.value).toBe(1)
    expect(v.detail).toContain("alerts-send at 7% of baseline")
  })

  it("⭐ the real 2026-09-10 shape — 11 lanes at once — is CRITICAL and names it a CALLER fault", () => {
    const degraded = [
      lane("wmc-fmv-populate", 0.042),
      lane("refresh_wmc_fmv_changed", 0.042),
      lane("refresh_wmc_fmv_drift_active", 0.042),
      lane("snapshot-pack-asks", 0.042),
      lane("alerts-send", 0.069),
      lane("pinnacle-events-ingest", 0.104),
      lane("allday-listings-indexer", 0.104),
      lane("allday-listings-retry", 0.104),
      lane("golazos-listings-indexer", 0.104),
      lane("pinnacle-listings-retry", 0.104),
      lane("alerts-dispatch", 0.125),
    ]
    const v = summariseCadenceCollapse(healthy({ degraded }))
    expect(v.status).toBe("critical")
    expect(v.value).toBe(11)
    expect(v.detail).toMatch(/CALLER fault/)
    expect(v.detail).toContain("+5 more")
  })

  it("the worst lanes are the ones that fit in the message, not the first six returned", () => {
    const degraded = [lane("mild", 0.39), lane("worst", 0.01), lane("bad", 0.1)]
    const v = summariseCadenceCollapse(healthy({ degraded }))
    const at = (n: string) => v.detail.indexOf(n)
    expect(at("worst")).toBeLessThan(at("bad"))
    expect(at("bad")).toBeLessThan(at("mild"))
  })

  it("both edges are configurable, so the split can be retuned from the DB", () => {
    const degraded = [lane("a", 0.1), lane("b", 0.1)]
    expect(summariseCadenceCollapse(healthy({ degraded }), 1, 2).status).toBe("critical")
    expect(summariseCadenceCollapse(healthy({ degraded }), 3, 9).status).toBe("ok")
  })

  it("PostgREST hands numerics back as strings — a string ratio must still render", () => {
    const v = summariseCadenceCollapse(
      healthy({ degraded: [{ pipeline: "s", ratio: "0.042", observed_per_day: "84", baseline_per_day: "2016" }] }),
    )
    expect(v.detail).toContain("s at 4% of baseline (84/day vs 2016)")
  })
})

describe("⛔ stopped lanes are CONTEXT, never a score", () => {
  it("a payload whose ONLY finding is stopped lanes is ok", () => {
    // These four are each covered by a registered, decided disposition (#50,
    // #21, #38, and offers-sweep's deliberate retirement). Scoring them would
    // make this arm permanently red on day one — the #25 trap.
    const stopped = [
      { pipeline: "compute-topshot-pack-ev", baseline_per_day: 429, last_run_at: null },
      { pipeline: "offers-sweep", baseline_per_day: 72, last_run_at: null },
      { pipeline: "topshot-moments-hydrator", baseline_per_day: 137.5, last_run_at: null },
      { pipeline: "topshot-pack-pool-backfill", baseline_per_day: 278.5, last_run_at: null },
    ]
    const v = summariseCadenceCollapse(healthy({ stopped }))
    expect(v.status).toBe("ok")
    // Reported, though — a guard that hides what it excluded makes its own
    // incidence unmeasurable.
    expect(v.detail).toContain("4 stopped")
    expect(v.detail).toContain("Pipeline Silence")
  })
})

describe("⚠ the ack pass must cover EVERY arm, not the ones above some line", () => {
  // It used to sit mid-file, so `Alert Delivery`, `Zero-Yield Lanes` and anything
  // added later were silently unackable. This pins the ordering that fixed it:
  // after the last arm, before the blackout arm that counts warns.
  const src = readFileSync("app/api/sentinel/route.ts", "utf8")

  it("runs after every evaluated arm — the ONLY push left after it is the blackout arm", () => {
    const ackAt = src.indexOf("const ack = cfgMap[c.name]?.ack;")
    expect(ackAt).toBeGreaterThan(0)
    // Count the arms that still push a check after the ack pass. Blackout is the
    // one legitimate straggler (it summarises the others and must come last); a
    // second would be an arm that can never be acknowledged, which is the defect.
    const after = src.slice(ackAt)
    expect(after.split("checks.push({").length - 1).toBe(1)
    expect(after).toContain("summariseBlindChecks(checks")
  })

  it("⛔ still runs BEFORE the Measurement Blackout arm, which counts warns", () => {
    const ackAt = src.indexOf("const ack = cfgMap[c.name]?.ack;")
    const blackoutAt = src.indexOf("summariseBlindChecks(checks")
    expect(blackoutAt).toBeGreaterThan(ackAt)
  })

  it("there is exactly ONE ack pass — a second copy would double-annotate", () => {
    expect(src.split("const ack = cfgMap[c.name]?.ack;").length - 1).toBe(1)
  })
})
