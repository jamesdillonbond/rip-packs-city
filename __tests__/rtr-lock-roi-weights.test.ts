import { describe, it, expect } from "vitest"
import {
  FMV_POINTS_DIVISOR,
  NEUTRAL_WEIGHT,
  TIER_POINT_WEIGHT,
  SERIAL_SCARCITY_MAX_LIFT,
  SERIAL_SCARCITY_DECAY,
  tierPointWeight,
  serialScarcityFactor,
  estimatePlayoffPointsRaw,
} from "@/lib/rtr-lock-roi-weights"

describe("tierPointWeight", () => {
  it("maps each known tier to its ordinal weight", () => {
    expect(tierPointWeight("COMMON")).toBe(1.0)
    expect(tierPointWeight("FANDOM")).toBe(1.1)
    expect(tierPointWeight("RARE")).toBe(1.6)
    expect(tierPointWeight("LEGENDARY")).toBe(3.0)
    expect(tierPointWeight("ULTIMATE")).toBe(6.0)
  })

  it("is case- and whitespace-insensitive", () => {
    expect(tierPointWeight("legendary")).toBe(3.0)
    expect(tierPointWeight("  Ultimate  ")).toBe(6.0)
  })

  it("falls back to the neutral weight for null/unknown tiers", () => {
    expect(tierPointWeight(null)).toBe(NEUTRAL_WEIGHT)
    expect(tierPointWeight(undefined)).toBe(NEUTRAL_WEIGHT)
    expect(tierPointWeight("")).toBe(NEUTRAL_WEIGHT)
    expect(tierPointWeight("CHALLENGER")).toBe(NEUTRAL_WEIGHT)
  })

  it("orders rarer tiers strictly above commoner ones", () => {
    const order = ["COMMON", "FANDOM", "RARE", "LEGENDARY", "ULTIMATE"]
    for (let i = 1; i < order.length; i++) {
      expect(tierPointWeight(order[i])).toBeGreaterThan(tierPointWeight(order[i - 1]))
    }
  })
})

describe("serialScarcityFactor", () => {
  it("returns the neutral weight for null/invalid/non-positive serials", () => {
    expect(serialScarcityFactor(null)).toBe(NEUTRAL_WEIGHT)
    expect(serialScarcityFactor(undefined)).toBe(NEUTRAL_WEIGHT)
    expect(serialScarcityFactor(0)).toBe(NEUTRAL_WEIGHT)
    expect(serialScarcityFactor(-5)).toBe(NEUTRAL_WEIGHT)
    expect(serialScarcityFactor(Number.NaN)).toBe(NEUTRAL_WEIGHT)
    expect(serialScarcityFactor(Number.POSITIVE_INFINITY)).toBe(NEUTRAL_WEIGHT)
  })

  it("gives serial #1 the maximum lift", () => {
    const expected = 1 + SERIAL_SCARCITY_MAX_LIFT * Math.exp(-1 / SERIAL_SCARCITY_DECAY)
    expect(serialScarcityFactor(1)).toBeCloseTo(expected, 10)
    // Never exceeds the 1.25 ceiling.
    expect(serialScarcityFactor(1)).toBeLessThanOrEqual(1 + SERIAL_SCARCITY_MAX_LIFT)
  })

  it("decays monotonically toward ~1.0 as serials grow", () => {
    expect(serialScarcityFactor(1)).toBeGreaterThan(serialScarcityFactor(50))
    expect(serialScarcityFactor(50)).toBeGreaterThan(serialScarcityFactor(250))
    expect(serialScarcityFactor(250)).toBeGreaterThan(serialScarcityFactor(2500))
    expect(serialScarcityFactor(2500)).toBeCloseTo(1.0, 3)
  })

  it("stays bounded within [1.0, 1.25] for every positive serial", () => {
    for (const s of [1, 5, 25, 100, 500, 10000]) {
      const f = serialScarcityFactor(s)
      expect(f).toBeGreaterThanOrEqual(1.0)
      expect(f).toBeLessThanOrEqual(1 + SERIAL_SCARCITY_MAX_LIFT)
    }
  })
})

describe("estimatePlayoffPointsRaw", () => {
  it("reproduces the route's exact v2 formula: (fmv / 10) * tier * scarcity", () => {
    const fmv = 120
    const expected = (fmv / FMV_POINTS_DIVISOR) * tierPointWeight("LEGENDARY") * serialScarcityFactor(3)
    expect(estimatePlayoffPointsRaw(fmv, "LEGENDARY", 3)).toBeCloseTo(expected, 10)
  })

  it("matches the plain floor-less base for a COMMON with unknown serial", () => {
    // tier weight 1.0, scarcity 1.0 -> exactly fmv / 10, unrounded.
    expect(estimatePlayoffPointsRaw(45, "COMMON", null)).toBeCloseTo(4.5, 10)
  })

  it("keeps a sub-$10 moment's points non-zero (fixes the v1 floor-to-0 bug)", () => {
    const pts = estimatePlayoffPointsRaw(4, "COMMON", null)
    expect(pts).toBeGreaterThan(0)
    expect(pts).toBeCloseTo(0.4, 10)
  })

  it("ranks a rarer/scarcer moment above a common one at the same FMV", () => {
    const rare = estimatePlayoffPointsRaw(100, "ULTIMATE", 1)
    const common = estimatePlayoffPointsRaw(100, "COMMON", 9999)
    expect(rare).toBeGreaterThan(common)
  })

  it("returns 0 for non-positive or non-finite FMV", () => {
    expect(estimatePlayoffPointsRaw(0, "ULTIMATE", 1)).toBe(0)
    expect(estimatePlayoffPointsRaw(-10, "ULTIMATE", 1)).toBe(0)
    expect(estimatePlayoffPointsRaw(Number.NaN, "ULTIMATE", 1)).toBe(0)
  })

  it("pointsPerDollar (raw / fmv) reduces to tier * scarcity / 10 and varies with quality", () => {
    const fmv = 250
    const ppd = estimatePlayoffPointsRaw(fmv, "RARE", 10) / fmv
    const expected = (tierPointWeight("RARE") * serialScarcityFactor(10)) / FMV_POINTS_DIVISOR
    expect(ppd).toBeCloseTo(expected, 10)
    // A common moment at the same price has a strictly lower ratio.
    const ppdCommon = estimatePlayoffPointsRaw(fmv, "COMMON", null) / fmv
    expect(ppd).toBeGreaterThan(ppdCommon)
  })
})

describe("exported calibration constants", () => {
  it("keeps the documented shape (guards accidental drift)", () => {
    expect(FMV_POINTS_DIVISOR).toBe(10)
    expect(NEUTRAL_WEIGHT).toBe(1.0)
    expect(SERIAL_SCARCITY_MAX_LIFT).toBe(0.25)
    expect(SERIAL_SCARCITY_DECAY).toBe(250)
    expect(Object.keys(TIER_POINT_WEIGHT).sort()).toEqual(
      ["COMMON", "FANDOM", "LEGENDARY", "RARE", "ULTIMATE"].sort(),
    )
  })
})
