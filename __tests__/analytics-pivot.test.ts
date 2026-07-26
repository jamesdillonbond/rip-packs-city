import { describe, it, expect } from "vitest"
import { pivotDailyTier, pivotDailySeries } from "@/lib/analytics-pivot"

describe("pivotDailyTier", () => {
  const rows = [
    { date: "2026-07-01", tier: "COMMON", sale_count: 5, volume: 100, avg_price: 20 },
    { date: "2026-07-01", tier: "RARE", sale_count: 2, volume: 300, avg_price: 150 },
    { date: "2026-07-02", tier: "COMMON", sale_count: 3, volume: 60, avg_price: 20 },
    { date: "2026-07-01", tier: "UNKNOWN", sale_count: 9, volume: 9, avg_price: 1 },
  ]
  it("buckets by date, picks the field, and zero-fills every tier", () => {
    const { data, tiers } = pivotDailyTier(rows, "volume")
    expect(tiers.sort()).toEqual(["COMMON", "RARE"])
    // dates sorted; RARE zero-filled on 07-02
    expect(data).toEqual([
      { date: "2026-07-01", COMMON: 100, RARE: 300 },
      { date: "2026-07-02", COMMON: 60, RARE: 0 },
    ])
  })
  it("drops UNKNOWN/empty tiers", () => {
    const { tiers } = pivotDailyTier(rows, "sale_count")
    expect(tiers).not.toContain("UNKNOWN")
  })
  it("respects the chosen numeric field", () => {
    const { data } = pivotDailyTier(rows, "sale_count")
    expect(data[0].COMMON).toBe(5)
  })
  it("empty/undefined → empty result", () => {
    expect(pivotDailyTier(undefined, "volume")).toEqual({ data: [], tiers: [] })
    expect(pivotDailyTier([], "volume")).toEqual({ data: [], tiers: [] })
  })
})

describe("pivotDailySeries", () => {
  const rows = [
    { date: "2026-07-01", series: 0, volume: 100 }, // seriesLabel(0) = "Series 1"
    { date: "2026-07-01", series: 0, volume: 50 }, // summed
    { date: "2026-07-01", series: 4, volume: 30 }, // "Series 3"
    { date: "2026-07-02", series: 0, volume: 20 },
    { date: "2026-07-01", series: 99, volume: 999 }, // "Unknown" — not a top key
  ]
  const topKeys = ["Series 1", "Series 3"]
  it("sums volume per (date, series-label), keeps only top keys, zero-fills, sorts", () => {
    expect(pivotDailySeries(rows, topKeys)).toEqual([
      { date: "2026-07-01", "Series 1": 150, "Series 3": 30 },
      { date: "2026-07-02", "Series 1": 20, "Series 3": 0 },
    ])
  })
  it("a series not in topKeys is excluded", () => {
    const out = pivotDailySeries(rows, topKeys)
    expect(out.some((r) => "Unknown" in r)).toBe(false)
  })
  it("empty/undefined → []", () => {
    expect(pivotDailySeries(undefined, topKeys)).toEqual([])
    expect(pivotDailySeries([], topKeys)).toEqual([])
  })
})
