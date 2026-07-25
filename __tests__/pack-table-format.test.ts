import { describe, it, expect } from "vitest"
import {
  tierRank,
  TIER_RANK,
  coverageChipClass,
  COVERAGE_NULL,
  COVERAGE_LOW,
  COVERAGE_HIGH,
  fmtPrice,
  fmtPct,
  marginClass,
  HEAVY_DEPLETION_THRESHOLD,
  fmtSlots,
  depletionChip,
  POOL_DEPLETION_THRESHOLD,
  comparePackValues,
  defaultSortDir,
} from "@/lib/pack-table-format"

// Pins the pure formatting/threshold/sort logic lifted out of
// components/packs/PackTable.tsx (which is invisible to the coverage ratchet).
// A regression here mis-ranks the packs table, mis-labels EV margins/prices,
// or drops the survivor-bias depletion warning.

describe("tierRank", () => {
  it("returns 0 for null/undefined/empty", () => {
    expect(tierRank(null)).toBe(0)
    expect(tierRank(undefined)).toBe(0)
    expect(tierRank("")).toBe(0)
  })
  it("maps known tiers by rarity (case-insensitive)", () => {
    expect(tierRank("COMMON")).toBe(1)
    expect(tierRank("common")).toBe(1)
    expect(tierRank("Fandom")).toBe(2)
    expect(tierRank("ULTIMATE")).toBe(7)
  })
  it("maps UFC tiers by rough rarity equivalence", () => {
    expect(tierRank("CONTENDER")).toBe(TIER_RANK.UNCOMMON)
    expect(tierRank("CHALLENGER")).toBe(TIER_RANK.EPIC)
  })
  it("returns 0 for an unknown tier", () => {
    expect(tierRank("MYTHIC")).toBe(0)
  })
  it("orders common < fandom < rare < legendary < ultimate", () => {
    const ranks = ["COMMON", "FANDOM", "RARE", "LEGENDARY", "ULTIMATE"].map(tierRank)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
  })
})

describe("coverageChipClass", () => {
  it("null coverage → neutral chip", () => {
    expect(coverageChipClass(null)).toBe(COVERAGE_NULL)
  })
  it("below 0.6 → low chip", () => {
    expect(coverageChipClass(0)).toBe(COVERAGE_LOW)
    expect(coverageChipClass(0.59)).toBe(COVERAGE_LOW)
  })
  it("0.6 and above → high chip", () => {
    expect(coverageChipClass(0.6)).toBe(COVERAGE_HIGH)
    expect(coverageChipClass(1)).toBe(COVERAGE_HIGH)
  })
})

describe("fmtPrice", () => {
  it("returns em-dash for null/undefined/non-finite", () => {
    expect(fmtPrice(null)).toBe("—")
    expect(fmtPrice(undefined)).toBe("—")
    expect(fmtPrice(Number.NaN)).toBe("—")
    expect(fmtPrice(Number.POSITIVE_INFINITY)).toBe("—")
  })
  it("formats finite values to 2 decimals with a dollar sign", () => {
    expect(fmtPrice(0)).toBe("$0.00")
    expect(fmtPrice(12.5)).toBe("$12.50")
    expect(fmtPrice(3.14159)).toBe("$3.14")
  })
})

describe("fmtPct", () => {
  it("returns em-dash for null/undefined/non-finite", () => {
    expect(fmtPct(null)).toBe("—")
    expect(fmtPct(undefined)).toBe("—")
    expect(fmtPct(Number.NaN)).toBe("—")
  })
  it("formats a fraction as a percentage with 1 decimal", () => {
    expect(fmtPct(0.12)).toBe("12.0%")
    expect(fmtPct(-0.05)).toBe("-5.0%")
    expect(fmtPct(0)).toBe("0.0%")
  })
})

describe("marginClass", () => {
  it("null pct → muted", () => {
    expect(marginClass(null)).toBe("text-[color:var(--rpc-text-muted)]")
  })
  it("positive margin on a heavily-depleted pool is muted to secondary", () => {
    expect(marginClass(0.5, HEAVY_DEPLETION_THRESHOLD)).toBe(
      "text-[color:var(--rpc-text-secondary)]",
    )
    expect(marginClass(0.5, 0.95)).toBe("text-[color:var(--rpc-text-secondary)]")
  })
  it("positive margin below the depletion threshold stays green", () => {
    expect(marginClass(0.5, 0.5)).toBe("text-emerald-400")
    expect(marginClass(0.5, null)).toBe("text-emerald-400")
    expect(marginClass(0.5)).toBe("text-emerald-400")
  })
  it("does not mute when depletion is non-finite", () => {
    expect(marginClass(0.5, Number.NaN)).toBe("text-emerald-400")
  })
  it("negative margin → red", () => {
    expect(marginClass(-0.1, 0.99)).toBe("text-red-400")
  })
  it("zero margin → secondary", () => {
    expect(marginClass(0)).toBe("text-[color:var(--rpc-text-secondary)]")
  })
})

describe("fmtSlots", () => {
  it("renders a positive integer slot count", () => {
    expect(fmtSlots(5)).toBe("5")
  })
  // 2026-07-25: the label now goes through humanizeLabel, so underscores become
  // spaces ("in_season_premium" used to render the literal "In_season_premium" on
  // the Golazos pack pages) and every word is Title Cased — matching the
  // `text-transform: capitalize` the pack-type chip already applies elsewhere.
  it("falls back to a humanized packType label when slots is null/0", () => {
    expect(fmtSlots(null, "bundle")).toBe("Bundle")
    expect(fmtSlots(0, "chance hit")).toBe("Chance Hit")
    expect(fmtSlots(null, "  reward ")).toBe("Reward")
    expect(fmtSlots(null, "in_season_premium")).toBe("In Season Premium")
    expect(fmtSlots(0, "IN_SEASON_PREMIUM")).toBe("In Season Premium")
  })
  it("returns em-dash when neither slots nor label are meaningful", () => {
    expect(fmtSlots(null)).toBe("—")
    expect(fmtSlots(0, "")).toBe("—")
    expect(fmtSlots(null, "   ")).toBe("—")
  })
})

describe("depletionChip", () => {
  it("returns null for null/non-finite depletion", () => {
    expect(depletionChip(null, 100)).toBeNull()
    expect(depletionChip(Number.NaN, 100)).toBeNull()
  })
  it("returns null below the pool-depletion threshold", () => {
    expect(depletionChip(POOL_DEPLETION_THRESHOLD - 0.01, 100)).toBeNull()
  })
  it("returns null when edition count is missing or non-positive", () => {
    expect(depletionChip(0.9, null)).toBeNull()
    expect(depletionChip(0.9, 0)).toBeNull()
    expect(depletionChip(0.9, -5)).toBeNull()
  })
  it("computes surviving count and label at/above the threshold", () => {
    expect(depletionChip(POOL_DEPLETION_THRESHOLD, 100)).toEqual({
      label: "🔥 30/100 remain",
      surviving: 30,
      total: 100,
    })
    expect(depletionChip(0.8, 50)).toEqual({
      label: "🔥 10/50 remain",
      surviving: 10,
      total: 50,
    })
  })
  it("clamps surviving to at least 1 when the pool is ~fully depleted", () => {
    const chip = depletionChip(1, 200)
    expect(chip).not.toBeNull()
    expect(chip!.surviving).toBe(1)
    expect(chip!.label).toBe("🔥 1/200 remain")
  })
})

describe("comparePackValues", () => {
  it("nulls sort to the end regardless of direction", () => {
    expect(comparePackValues(null, null, false, "asc")).toBe(0)
    expect(comparePackValues(null, 5, false, "asc")).toBe(1)
    expect(comparePackValues(null, 5, false, "desc")).toBe(1)
    expect(comparePackValues(5, null, false, "asc")).toBe(-1)
    expect(comparePackValues(5, undefined, false, "desc")).toBe(-1)
  })
  it("compares numbers ascending", () => {
    expect(comparePackValues(1, 2, false, "asc")).toBe(-1)
    expect(comparePackValues(2, 1, false, "asc")).toBe(1)
    expect(comparePackValues(2, 2, false, "asc")).toBe(0)
  })
  it("compares numbers descending", () => {
    expect(comparePackValues(1, 2, false, "desc")).toBe(1)
    expect(comparePackValues(2, 1, false, "desc")).toBe(-1)
  })
  it("compares strings case-insensitively", () => {
    expect(comparePackValues("Apple", "banana", false, "asc")).toBe(-1)
    expect(comparePackValues("BANANA", "apple", false, "asc")).toBe(1)
    expect(comparePackValues("Same", "same", false, "asc")).toBe(0)
  })
  it("tier sort ranks by rarity, not alphabetically", () => {
    // COMMON (1) vs LEGENDARY (6): ascending puts COMMON first even though
    // 'legendary' < 'common' alphabetically.
    expect(comparePackValues("COMMON", "LEGENDARY", true, "asc")).toBe(-1)
    expect(comparePackValues("COMMON", "LEGENDARY", true, "desc")).toBe(1)
    expect(comparePackValues("RARE", "RARE", true, "asc")).toBe(0)
  })
  it("produces a stable rarity ordering when used as an array comparator", () => {
    const tiers = ["ULTIMATE", "COMMON", "RARE", "FANDOM", "LEGENDARY"]
    const sorted = [...tiers].sort((a, b) => comparePackValues(a, b, true, "asc"))
    expect(sorted).toEqual(["COMMON", "FANDOM", "RARE", "LEGENDARY", "ULTIMATE"])
  })
})

describe("defaultSortDir", () => {
  it("title and tier open ascending", () => {
    expect(defaultSortDir("title")).toBe("asc")
    expect(defaultSortDir("tier")).toBe("asc")
  })
  it("every other column opens descending", () => {
    expect(defaultSortDir("price")).toBe("desc")
    expect(defaultSortDir("grossEV")).toBe("desc")
    expect(defaultSortDir("evMarginPct")).toBe("desc")
  })
})
