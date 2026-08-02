import { describe, it, expect } from "vitest"
import { filterAndSortSets, tierStripeColor, TIER_STRIPE, type DisplaySet } from "@/lib/sets/display"

const S = (setName: string, completionPct: number, totalMissingCost?: number | null): DisplaySet => ({
  setName,
  completionPct,
  totalMissingCost,
})

const sets = [
  S("Bravo", 100, 0),
  S("Alpha", 50, 200),
  S("Delta", 0, null),
  S("Charlie", 0, 30),
]

describe("sets/display — filterAndSortSets filters", () => {
  it("filter=complete keeps only 100%", () => {
    expect(filterAndSortSets(sets, "complete", "name").map((s) => s.setName)).toEqual(["Bravo"])
  })
  it("filter=in_progress keeps strictly-between-0-and-100", () => {
    expect(filterAndSortSets(sets, "in_progress", "name").map((s) => s.setName)).toEqual(["Alpha"])
  })
  it("filter=not_started keeps only 0%", () => {
    expect(filterAndSortSets(sets, "not_started", "name").map((s) => s.setName)).toEqual(["Charlie", "Delta"])
  })
  it("filter=all keeps everything", () => {
    expect(filterAndSortSets(sets, "all", "name")).toHaveLength(4)
  })
})

describe("sets/display — filterAndSortSets sorts", () => {
  it("completion sorts descending", () => {
    expect(filterAndSortSets(sets, "all", "completion").map((s) => s.completionPct)).toEqual([100, 50, 0, 0])
  })
  it("cost sorts ascending with missing cost (null) sorting last", () => {
    expect(filterAndSortSets(sets, "all", "cost").map((s) => s.setName)).toEqual(["Bravo", "Charlie", "Alpha", "Delta"])
  })
  it("name sorts by locale", () => {
    expect(filterAndSortSets(sets, "all", "name").map((s) => s.setName)).toEqual(["Alpha", "Bravo", "Charlie", "Delta"])
  })
})

describe("sets/display — purity", () => {
  it("does not mutate the input array", () => {
    const input = [...sets]
    const before = input.map((s) => s.setName)
    filterAndSortSets(input, "all", "completion")
    expect(input.map((s) => s.setName)).toEqual(before)
  })
  it("handles an empty list", () => {
    expect(filterAndSortSets([], "all", "cost")).toEqual([])
  })
})

describe("tierStripeColor", () => {
  it("maps NBA Top Shot tiers to their stripe colors", () => {
    expect(tierStripeColor("LEGENDARY")).toBe(TIER_STRIPE.LEGENDARY)
    expect(tierStripeColor("ULTIMATE")).toBe(TIER_STRIPE.ULTIMATE)
    expect(tierStripeColor("COMMON")).toBe(TIER_STRIPE.COMMON)
  })
  it("maps the UFC Strike tier vocabulary", () => {
    expect(tierStripeColor("CHALLENGER")).toBe(TIER_STRIPE.CHALLENGER)
    expect(tierStripeColor("CONTENDER")).toBe(TIER_STRIPE.CONTENDER)
    expect(tierStripeColor("CHAMPION")).toBe(TIER_STRIPE.CHAMPION)
  })
  it("is case-insensitive", () => {
    expect(tierStripeColor("legendary")).toBe(TIER_STRIPE.LEGENDARY)
    expect(tierStripeColor("Rare")).toBe(TIER_STRIPE.RARE)
  })
  it("falls back to COMMON for null/undefined/unknown tiers", () => {
    expect(tierStripeColor(null)).toBe(TIER_STRIPE.COMMON)
    expect(tierStripeColor(undefined)).toBe(TIER_STRIPE.COMMON)
    expect(tierStripeColor("")).toBe(TIER_STRIPE.COMMON)
    expect(tierStripeColor("NOT_A_TIER")).toBe(TIER_STRIPE.COMMON)
  })
})
