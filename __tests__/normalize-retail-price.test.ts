import { describe, it, expect } from "vitest"
import { normalizePackRetailPrice } from "@/lib/packs/normalize-retail-price"

// Pins the 10⁸-wei vs plain-dollars disambiguation. This value feeds
// reward-pack detection (retail_price_usd === 0 → suppress EV verdicts) and
// every pack value-ratio, so a threshold regression mis-labels real drops as
// free packs or renders $9M where $9 belongs.

describe("normalizePackRetailPrice", () => {
  it("passes plain-dollar values through unchanged", () => {
    expect(normalizePackRetailPrice(9)).toBe(9)
    expect(normalizePackRetailPrice(2)).toBe(2)
    expect(normalizePackRetailPrice(99_999)).toBe(99_999)
  })

  it("converts 10⁸-denominated wei values back to dollars", () => {
    expect(normalizePackRetailPrice(900_000_000)).toBe(9)
    expect(normalizePackRetailPrice(200_000_000)).toBe(2)
  })

  it("treats exactly 1_000_000 as wei (>= threshold)", () => {
    expect(normalizePackRetailPrice(1_000_000)).toBe(0.01)
  })

  it("treats just under the threshold as plain dollars", () => {
    expect(normalizePackRetailPrice(999_999)).toBe(999_999)
  })

  it("returns 0 for zero / negative / non-finite / junk input", () => {
    expect(normalizePackRetailPrice(0)).toBe(0)
    expect(normalizePackRetailPrice(-5)).toBe(0)
    expect(normalizePackRetailPrice(null)).toBe(0)
    expect(normalizePackRetailPrice(undefined)).toBe(0)
    expect(normalizePackRetailPrice(NaN)).toBe(0)
    expect(normalizePackRetailPrice("not a number")).toBe(0)
  })

  it("coerces numeric strings (GraphQL sometimes returns strings)", () => {
    expect(normalizePackRetailPrice("9")).toBe(9)
    expect(normalizePackRetailPrice("900000000")).toBe(9)
  })
})
