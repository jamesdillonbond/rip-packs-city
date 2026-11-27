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
  fmtSlotsLine,
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

// 2026-11-16: the mobile card read "1 slots", "— slots" and "Reward slots" live
describe("fmtSlotsLine", () => {
  it("pluralizes a count", () => {
    expect(fmtSlotsLine(1)).toBe("1 slot")
    expect(fmtSlotsLine(5)).toBe("5 slots")
  })
  it("a pack-type label stands alone, with no 'slots' after it", () => {
    expect(fmtSlotsLine(null, "reward")).toBe("Reward")
    expect(fmtSlotsLine(0, "in_season_premium")).toBe("In Season Premium")
  })
  it("nothing known → null, never a dash", () => {
    expect(fmtSlotsLine(null)).toBeNull()
    expect(fmtSlotsLine(0, "  ")).toBeNull()
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
  // 2026-11-27: a one-edition pack (Memphis Grizzlies Leaderboard Reward: Fit Check (Diced),
  // 10 minted, 2 sealed) read "🔥 1/1 remain" — read as a one-of-one serial it does not hold.
  it("never renders a chip on a one-edition pack, however opened", () => {
    expect(depletionChip(0.8, 1)).toBeNull()
    expect(depletionChip(0.99, 1)).toBeNull()
  })
  it("states the share opened at/above the threshold — no invented edition count", () => {
    expect(depletionChip(POOL_DEPLETION_THRESHOLD, 100)).toEqual({ label: "🔥 70% opened", openedPct: 70 })
    expect(depletionChip(0.8, 50)).toEqual({ label: "🔥 80% opened", openedPct: 80 })
    // The old label claimed surviving EDITIONS from a SUPPLY share; nothing may say "remain" or N/M.
    for (const [p, n] of [[0.7, 2], [0.95, 34], [1, 200]] as const) {
      const label = depletionChip(p, n)!.label
      expect(label).not.toMatch(/remain/)
      expect(label).not.toMatch(/\d+\s*\/\s*\d+/)
    }
  })
  it("never says 100% opened (a listed pool still has packs) and never rounds up", () => {
    expect(depletionChip(1, 200)!.label).toBe("🔥 99% opened")
    expect(depletionChip(0.989, 200)!.label).toBe("🔥 98% opened")
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
