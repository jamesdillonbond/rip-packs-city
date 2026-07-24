import { describe, it, expect } from "vitest"
import {
  tierColor,
  fmtUsd,
  fmtPct,
  atLeastOnce,
  selectPackPrice,
} from "@/lib/grail-format"

// Pins the pure formatting/threshold/probability logic lifted out of
// components/packs/GrailsView.tsx (which is invisible to the coverage ratchet).
// A regression here mis-colors chase tiers, mis-formats grail prices/odds, or
// mis-computes the per-pack "at least once" probability.

describe("tierColor", () => {
  it("maps each known tier substring to its accent (case-insensitive)", () => {
    expect(tierColor("ULTIMATE")).toBe("#EC4899")
    expect(tierColor("legendary")).toBe("#F59E0B")
    expect(tierColor("Rare")).toBe("#818CF8")
    expect(tierColor("FANDOM")).toBe("#34D399")
    expect(tierColor("common")).toBe("#9CA3AF")
    expect(tierColor("Premium")).toBe("#A855F7")
    expect(tierColor("standard")).toBe("#6B7280")
  })
  it("matches on substring, ranking ultimate before legendary", () => {
    // both substrings present — ultimate is checked first
    expect(tierColor("ultimate legendary")).toBe("#EC4899")
    expect(tierColor("legendary chase")).toBe("#F59E0B")
  })
  it("falls back to neutral gray for null/undefined/empty/unknown", () => {
    expect(tierColor(null)).toBe("#6B7280")
    expect(tierColor(undefined)).toBe("#6B7280")
    expect(tierColor("")).toBe("#6B7280")
    expect(tierColor("mythic")).toBe("#6B7280")
  })
})

describe("fmtUsd", () => {
  it("returns em-dash for null/undefined/non-finite", () => {
    expect(fmtUsd(null)).toBe("—")
    expect(fmtUsd(undefined)).toBe("—")
    expect(fmtUsd(Number.NaN)).toBe("—")
    expect(fmtUsd(Number.POSITIVE_INFINITY)).toBe("—")
  })
  it("formats sub-$1000 values with 2 decimals", () => {
    expect(fmtUsd(0)).toBe("$0.00")
    expect(fmtUsd(12.5)).toBe("$12.50")
    expect(fmtUsd(3.14159)).toBe("$3.14")
    expect(fmtUsd(999.99)).toBe("$999.99")
  })
  it("rounds to whole dollars with separators at/above $1,000", () => {
    expect(fmtUsd(1000)).toBe("$1,000")
    expect(fmtUsd(1234.56)).toBe("$1,235")
    expect(fmtUsd(1250000)).toBe("$1,250,000")
  })
  it("uses absolute-value threshold for negatives", () => {
    expect(fmtUsd(-1500.4)).toBe("$-1,500")
    expect(fmtUsd(-12.5)).toBe("$-12.50")
  })
})

describe("fmtPct", () => {
  it("returns em-dash for null/undefined/non-finite", () => {
    expect(fmtPct(null)).toBe("—")
    expect(fmtPct(undefined)).toBe("—")
    expect(fmtPct(Number.NaN)).toBe("—")
  })
  it("uses 2 decimals below 1% and 1 decimal at/above 1%", () => {
    expect(fmtPct(0.005)).toBe("0.50%")
    expect(fmtPct(0.0001)).toBe("0.01%")
    expect(fmtPct(0.01)).toBe("1.0%")
    expect(fmtPct(0.125)).toBe("12.5%")
    expect(fmtPct(1)).toBe("100.0%")
    expect(fmtPct(0)).toBe("0.00%")
  })
})

describe("atLeastOnce", () => {
  it("returns null for null/undefined/non-finite per-slot probability", () => {
    expect(atLeastOnce(null, 5)).toBeNull()
    expect(atLeastOnce(undefined, 5)).toBeNull()
    expect(atLeastOnce(Number.NaN, 5)).toBeNull()
  })
  it("clamps at 0 for non-positive p", () => {
    expect(atLeastOnce(0, 5)).toBe(0)
    expect(atLeastOnce(-0.1, 5)).toBe(0)
  })
  it("clamps at 1 for p >= 1", () => {
    expect(atLeastOnce(1, 5)).toBe(1)
    expect(atLeastOnce(1.5, 5)).toBe(1)
  })
  it("computes 1 - (1-p)^slots for interior probabilities", () => {
    expect(atLeastOnce(0.1, 1)).toBeCloseTo(0.1, 10)
    expect(atLeastOnce(0.1, 2)).toBeCloseTo(0.19, 10)
    expect(atLeastOnce(0.5, 3)).toBeCloseTo(0.875, 10)
  })
  it("is monotonic increasing in slot count", () => {
    const a = atLeastOnce(0.2, 1)!
    const b = atLeastOnce(0.2, 5)!
    const c = atLeastOnce(0.2, 10)!
    expect(a).toBeLessThan(b)
    expect(b).toBeLessThan(c)
  })
})

describe("selectPackPrice", () => {
  it("prefers primary price and labels it PRIMARY", () => {
    expect(selectPackPrice(10, 8)).toEqual({ price: 10, priceLabel: "PRIMARY" })
    expect(selectPackPrice(10, null)).toEqual({ price: 10, priceLabel: "PRIMARY" })
    expect(selectPackPrice(0, 8)).toEqual({ price: 0, priceLabel: "PRIMARY" })
  })
  it("falls back to secondary ask labeled SECONDARY when no primary", () => {
    expect(selectPackPrice(null, 8)).toEqual({ price: 8, priceLabel: "SECONDARY" })
    expect(selectPackPrice(undefined, 8)).toEqual({ price: 8, priceLabel: "SECONDARY" })
  })
  it("returns null price and null label when neither is present", () => {
    expect(selectPackPrice(null, null)).toEqual({ price: null, priceLabel: null })
    expect(selectPackPrice(undefined, undefined)).toEqual({ price: null, priceLabel: null })
  })
})
