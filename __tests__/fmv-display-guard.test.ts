import { describe, it, expect } from "vitest"
import { guardTopshotFmv, type FmvGuardMap, type FmvGuardEntry } from "@/lib/fmv-display-guard"

// Pins the Top Shot FMV display clamp — the guard that stops a stored FMV
// disconnected from active trading (or above the 90d max sale) from rendering a
// fake discount on /api/market + /api/sniper-feed. Regression re-surfaces the
// inflated FMVs the guard exists to suppress.

function guardMap(entries: Record<string, Partial<FmvGuardEntry>>): FmvGuardMap {
  const m: FmvGuardMap = new Map()
  for (const [key, e] of Object.entries(entries)) {
    m.set(key, {
      maxSale90d: e.maxSale90d ?? 0,
      isThin: e.isThin ?? false,
      fmvExceedsMax: e.fmvExceedsMax ?? false,
      fmvDisconnected: e.fmvDisconnected ?? false,
      clampTarget: e.clampTarget ?? 0,
    })
  }
  return m
}

describe("guardTopshotFmv", () => {
  it("passes FMV through unchanged when there is no guard entry", () => {
    const r = guardTopshotFmv(guardMap({}), "73:2785", 500)
    expect(r).toEqual({ effectiveFmv: 500, lowConfidenceFmv: false })
  })

  it("returns the raw value + no caveat for null key or non-positive fmv", () => {
    expect(guardTopshotFmv(guardMap({}), null, 100)).toEqual({ effectiveFmv: 100, lowConfidenceFmv: false })
    expect(guardTopshotFmv(guardMap({ "1:2": { isThin: true } }), "1:2", 0)).toEqual({
      effectiveFmv: 0,
      lowConfidenceFmv: false,
    })
  })

  it("clamps to the 90d max when fmv exceeds it", () => {
    const g = guardMap({ "1:2": { fmvExceedsMax: true, maxSale90d: 120 } })
    const r = guardTopshotFmv(g, "1:2", 500)
    expect(r.effectiveFmv).toBe(120)
    expect(r.lowConfidenceFmv).toBe(true)
  })

  it("clamps to the p90 target when fmv is disconnected from trading", () => {
    const g = guardMap({ "1:2": { fmvDisconnected: true, clampTarget: 45 } })
    expect(guardTopshotFmv(g, "1:2", 500).effectiveFmv).toBe(45)
  })

  it("takes the tightest bound when both clamps apply", () => {
    const g = guardMap({ "1:2": { fmvExceedsMax: true, maxSale90d: 120, fmvDisconnected: true, clampTarget: 45 } })
    expect(guardTopshotFmv(g, "1:2", 500).effectiveFmv).toBe(45)
  })

  it("flags thin data as low-confidence without changing the value", () => {
    const g = guardMap({ "1:2": { isThin: true } })
    expect(guardTopshotFmv(g, "1:2", 500)).toEqual({ effectiveFmv: 500, lowConfidenceFmv: true })
  })

  it("falls back to the base '::' key when the parallel key has no entry", () => {
    const g = guardMap({ "1:2": { fmvExceedsMax: true, maxSale90d: 90 } })
    // parallel key "1:2::19" not present → falls back to base "1:2"
    expect(guardTopshotFmv(g, "1:2::19", 500).effectiveFmv).toBe(90)
  })

  it("does not clamp when the bound is zero/absent even if the flag is set", () => {
    const g = guardMap({ "1:2": { fmvExceedsMax: true, maxSale90d: 0 } })
    expect(guardTopshotFmv(g, "1:2", 500).effectiveFmv).toBe(500)
  })
})
