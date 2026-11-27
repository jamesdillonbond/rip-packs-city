import { describe, it, expect } from "vitest"
import { askHeavyPct, poolMixMeasuredFlat, type PoolSkewRow } from "@/lib/packs/pool-skew"

const NOW = Date.parse("2026-11-27T19:00:00Z")
// Base Set (Series 2, Release 32), measured 11-27: 98 % drawn, mix unchanged.
const flat: PoolSkewRow = { dist_id: "1740", listed_share: "1.0000", skew: "0.99", fmv_coverage: "1.0000", pool_fetched_at: "2026-11-20T00:00:00Z", computed_at: "2026-11-27T18:23:00Z" }

describe("poolMixMeasuredFlat — only ever clears a warning on a full measurement", () => {
  it("clears a pool whose remaining mix matches launch", () => {
    expect(poolMixMeasuredFlat(flat, NOW)).toBe(true)
  })
  it("keeps the warning on a measured chase skew (Grail Seekers February 5.6×)", () => {
    expect(poolMixMeasuredFlat({ ...flat, skew: "5.63" }, NOW)).toBe(false)
    expect(poolMixMeasuredFlat({ ...flat, skew: 1.5 }, NOW)).toBe(false)
  })
  it("keeps the warning where sold-out editions vanished from the pool table (dist 5223: 0.10)", () => {
    expect(poolMixMeasuredFlat({ ...flat, listed_share: "0.10" }, NOW)).toBe(false)
    expect(poolMixMeasuredFlat({ ...flat, listed_share: null }, NOW)).toBe(false)
  })
  it("keeps the warning on thin FMV coverage, a stale or missing read, or no row at all", () => {
    expect(poolMixMeasuredFlat({ ...flat, fmv_coverage: "0.80" }, NOW)).toBe(false)
    expect(poolMixMeasuredFlat({ ...flat, skew: null }, NOW)).toBe(false)
    expect(poolMixMeasuredFlat({ ...flat, pool_fetched_at: "2026-09-01T00:00:00Z" }, NOW)).toBe(false)
    expect(poolMixMeasuredFlat({ ...flat, pool_fetched_at: null }, NOW)).toBe(false)
    // The hourly measurement stopped: a frozen ratio never clears a warning.
    expect(poolMixMeasuredFlat({ ...flat, computed_at: "2026-11-25T00:00:00Z" }, NOW)).toBe(false)
    expect(poolMixMeasuredFlat({ ...flat, computed_at: null }, NOW)).toBe(false)
    expect(poolMixMeasuredFlat(null, NOW)).toBe(false)
    expect(poolMixMeasuredFlat(undefined, NOW)).toBe(false)
  })
})

describe("askHeavyPct — the share of value resting on never-sold asks", () => {
  it("names it at >= 50 % on a fresh measurement (Fit Check (Diced): 100 %)", () => {
    expect(askHeavyPct({ ...flat, ask_value_share: "1.0000" }, NOW)).toBe(100)
    expect(askHeavyPct({ ...flat, ask_value_share: 0.5 }, NOW)).toBe(50)
  })
  it("stays silent below 50 %, on a missing value, or on a stale measurement", () => {
    expect(askHeavyPct({ ...flat, ask_value_share: "0.0011" }, NOW)).toBeNull()
    expect(askHeavyPct({ ...flat, ask_value_share: null }, NOW)).toBeNull()
    expect(askHeavyPct({ ...flat, ask_value_share: 1, computed_at: "2026-11-25T00:00:00Z" }, NOW)).toBeNull()
    expect(askHeavyPct(null, NOW)).toBeNull()
  })
})
