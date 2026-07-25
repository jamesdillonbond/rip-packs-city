import { describe, it, expect } from "vitest"
import {
  trimmedMedian,
  weightedAveragePrice,
  liquidityRating,
  wapWithoutOutliers,
  medianOf,
  lowSerialThreshold,
  isPremiumSerial,
  dampenGrailSpike,
  DUST_PRICE_USD,
  GRAIL_SERIAL_MAX,
  LOW_SERIAL_FLOOR_ABS,
  type SerialSale,
} from "@/lib/fmv-recalc-math"

// Pins the FMV price-math primitives extracted from app/api/fmv-recalc/route.ts.
// These decide the displayed fair-market value of every edition, so every branch
// (empty sets, medians, decay tiers, serial-premium thresholds, grail dampening)
// is asserted. A fixed `now` keeps the recency-weighted functions deterministic.

const NOW = new Date("2026-01-15T00:00:00Z")
const daysAgo = (d: number): Date => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000)
const sale = (price: number, d = 1): { price: number; soldAt: Date } => ({ price, soldAt: daysAgo(d) })
const ssale = (price: number, serial: number | null, d = 1): SerialSale => ({ price, soldAt: daysAgo(d), serial })

describe("trimmedMedian", () => {
  it("returns 0 for an empty array", () => expect(trimmedMedian([])).toBe(0))
  it("returns the single element for length 1", () => expect(trimmedMedian([42])).toBe(42))
  it("averages the two for length 2 (even, no trim)", () => expect(trimmedMedian([10, 20])).toBe(15))
  it("sorts before computing", () => expect(trimmedMedian([20, 10])).toBe(15))
  it("trims 10% each end for length >= 3 (odd result)", () => {
    // trimCount=1 → drops min+max → [middle]
    expect(trimmedMedian([1, 50, 1000])).toBe(50)
  })
  it("trims and averages the middle two (even after trim)", () => {
    // len 4, trimCount=1 → slice(1,3) = [10,20] → 15
    expect(trimmedMedian([1, 10, 20, 1000])).toBe(15)
  })
})

describe("weightedAveragePrice", () => {
  it("returns 0 for no sales", () => expect(weightedAveragePrice([], NOW)).toBe(0))
  it("weights recent sales 3x, mid 2x, old 1x", () => {
    // 100@3d (w3), 100@10d (w2), 100@20d (w1) → all same price → 100
    expect(weightedAveragePrice([sale(100, 3), sale(100, 10), sale(100, 20)], NOW)).toBe(100)
  })
  it("skews toward the recent price", () => {
    // 300@1d (w3) + 100@20d (w1) → (900+100)/4 = 250
    expect(weightedAveragePrice([sale(300, 1), sale(100, 20)], NOW)).toBe(250)
  })
  it("applies the 7- and 14-day tier boundaries inclusively", () => {
    // 10@7d → w3, 10@14d → w2 → weighted mean still 10 (equal prices)
    expect(weightedAveragePrice([sale(10, 7), sale(10, 14)], NOW)).toBe(10)
  })
})

describe("liquidityRating", () => {
  it("maps sale counts to the 0–5 scale at every boundary", () => {
    expect(liquidityRating(0)).toBe(0)
    expect(liquidityRating(5)).toBe(1)
    expect(liquidityRating(6)).toBe(2)
    expect(liquidityRating(20)).toBe(2)
    expect(liquidityRating(21)).toBe(3)
    expect(liquidityRating(50)).toBe(3)
    expect(liquidityRating(51)).toBe(4)
    expect(liquidityRating(100)).toBe(4)
    expect(liquidityRating(101)).toBe(5)
  })
})

describe("wapWithoutOutliers", () => {
  it("returns 0 for no sales", () => expect(wapWithoutOutliers([], NOW)).toBe(0))
  it("drops >5x and <0.2x-median wash/fat-finger sales", () => {
    // median of [9,10,11,9000] is 10.5; 9000 (>5x) dropped → wap of the three ~9.67
    const r = wapWithoutOutliers([sale(9), sale(10), sale(11), sale(9000)], NOW)
    expect(r).toBeGreaterThan(9)
    expect(r).toBeLessThan(12)
  })
  it("falls back to plain weighted average when the median is non-positive", () => {
    // all-zero prices → median 0 → fallback path (returns 0)
    expect(wapWithoutOutliers([sale(0), sale(0)], NOW)).toBe(0)
  })
})

describe("medianOf", () => {
  it("returns 0 for empty", () => expect(medianOf([])).toBe(0))
  it("returns the middle for odd length (sorted)", () => expect(medianOf([30, 10, 20])).toBe(20))
  it("averages the middle two for even length", () => expect(medianOf([10, 20, 30, 40])).toBe(25))
})

describe("lowSerialThreshold", () => {
  it("uses the absolute floor for null / non-positive circulation", () => {
    expect(lowSerialThreshold(null)).toBe(LOW_SERIAL_FLOOR_ABS)
    expect(lowSerialThreshold(0)).toBe(LOW_SERIAL_FLOOR_ABS)
    expect(lowSerialThreshold(-5)).toBe(LOW_SERIAL_FLOOR_ABS)
  })
  it("floors at 15 when 10% of circ is smaller", () => {
    // circ 100: band=max(15,10)=15, cap=max(1,25)=25 → min 15
    expect(lowSerialThreshold(100)).toBe(15)
  })
  it("scales the band up with circulation", () => {
    // circ 200: band=max(15,20)=20, cap=50 → 20
    expect(lowSerialThreshold(200)).toBe(20)
  })
  it("lets the 25% cap bind on small print runs", () => {
    // circ 40: band=max(15,4)=15, cap=max(1,10)=10 → min 10
    expect(lowSerialThreshold(40)).toBe(10)
    // circ 1: band=15, cap=max(1,0)=1 → 1
    expect(lowSerialThreshold(1)).toBe(1)
  })
})

describe("isPremiumSerial", () => {
  it("treats a null serial as typical (not premium)", () => {
    expect(isPremiumSerial(null, 100, 23)).toBe(false)
  })
  it("flags serial #1", () => expect(isPremiumSerial(1, 500, null)).toBe(true))
  it("flags the last-mint / perfect serial (serial === circ)", () => {
    expect(isPremiumSerial(500, 500, null)).toBe(true)
  })
  it("flags the jersey-match serial", () => {
    expect(isPremiumSerial(23, 500, 23)).toBe(true)
  })
  it("flags a low serial below the circulation-scaled threshold", () => {
    // circ 200 → threshold 20; serial 12 <= 20 → premium
    expect(isPremiumSerial(12, 200, null)).toBe(true)
  })
  it("treats a typical mid-run serial as non-premium", () => {
    expect(isPremiumSerial(120, 200, 7)).toBe(false)
  })
})

describe("dampenGrailSpike", () => {
  it("drops dust below $0.50 and returns a thin-set cap when <=1 survivor", () => {
    const { cleaned, capValue } = dampenGrailSpike([ssale(0.4, 5), ssale(10, 6)], { isCommonish: false })
    expect(cleaned.map(s => s.price)).toEqual([10])
    expect(capValue).toBe(30) // median(10)*3
  })
  it("removes a low-serial grail that dwarfs the rest (>3x rest median, serial<=10)", () => {
    const sales = [ssale(20, 50), ssale(22, 51), ssale(21, 52), ssale(9000, 1)]
    const { cleaned } = dampenGrailSpike(sales, { isCommonish: false })
    expect(cleaned.some(s => s.price === 9000)).toBe(false)
    expect(cleaned).toHaveLength(3)
  })
  it("keeps a high top sale when its serial is not a grail serial", () => {
    // serial 500 > GRAIL_SERIAL_MAX → low-serial removal does not apply
    const sales = [ssale(20, 50), ssale(22, 51), ssale(60, 500)]
    const { cleaned } = dampenGrailSpike(sales, { isCommonish: false })
    expect(cleaned.some(s => s.price === 60)).toBe(true)
  })
  it("applies the commonish thin-window safeguard (drop lone >5x spike)", () => {
    // 2-4 sales, hi (60) > 5x lo (6), serial not a grail → generic/step-4 drops the top
    const sales = [ssale(6, 400), ssale(60, 401)]
    const { cleaned } = dampenGrailSpike(sales, { isCommonish: true })
    expect(cleaned.map(s => s.price)).toEqual([6])
  })
  it("leaves a modest high-tier spread intact", () => {
    const sales = [ssale(50, 100), ssale(60, 101), ssale(70, 102)]
    const { cleaned } = dampenGrailSpike(sales, { isCommonish: false })
    expect(cleaned).toHaveLength(3)
  })
})

describe("exported constants", () => {
  it("carry the tuning values the route relied on", () => {
    expect(DUST_PRICE_USD).toBe(0.5)
    expect(GRAIL_SERIAL_MAX).toBe(10)
    expect(LOW_SERIAL_FLOOR_ABS).toBe(15)
  })
})
