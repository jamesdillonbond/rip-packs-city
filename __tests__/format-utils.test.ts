import { describe, it, expect } from "vitest"
import { formatCurrency, formatCount } from "@/lib/format"
import { normalizeParallel, buildMarketScopeKey } from "@/lib/market-scope"
import { getEditionKey, buildEditionStats } from "@/lib/edition-utils"
import { borderCosmetic, bannerCosmetic } from "@/lib/cosmetics"

// Small shared utilities: money/count formatting, market scope key, edition
// aggregation, cosmetic lookups. Deterministic; pin the documented semantics.

describe("formatCurrency / formatCount", () => {
  it("distinguishes missing (—) from a real zero ($0)", () => {
    expect(formatCurrency(null)).toBe("—")
    expect(formatCurrency(undefined)).toBe("—")
    expect(formatCurrency(NaN)).toBe("—")
    expect(formatCurrency(0)).toBe("$0")
  })
  it("formats positive + negative with thousands", () => {
    expect(formatCurrency(1234.5)).toBe("$1,234.50")
    expect(formatCurrency(-1234.5)).toBe("-$1,234.50")
  })
  it("formatCount groups and em-dashes missing", () => {
    expect(formatCount(12345)).toBe("12,345")
    expect(formatCount(null)).toBe("—")
  })
})

describe("market-scope", () => {
  it("normalizeParallel returns null for empty (distinct from wallet-normalize's 'Base')", () => {
    expect(normalizeParallel("")).toBeNull()
    expect(normalizeParallel("  ")).toBeNull()
    expect(normalizeParallel(" Hexwave ")).toBe("Hexwave")
  })
  it("buildMarketScopeKey joins edition::parallel with 'none'/'base' fallbacks", () => {
    expect(buildMarketScopeKey("73:2785", "Hexwave")).toBe("73:2785::Hexwave")
    expect(buildMarketScopeKey("73:2785")).toBe("73:2785::base")
    expect(buildMarketScopeKey()).toBe("none::base")
  })
})

describe("edition-utils", () => {
  it("getEditionKey composes setId-playId-parallel", () => {
    expect(getEditionKey({ setId: 73, playId: 2785, parallel: "Hexwave" })).toBe("73-2785-Hexwave")
    expect(getEditionKey({ setId: 73, playId: 2785 })).toBe("73-2785-base")
  })

  it("buildEditionStats tallies owned + locked per edition key", () => {
    const stats = buildEditionStats([
      { setId: 1, playId: 2, locked: false },
      { setId: 1, playId: 2, locked: true },
      { setId: 9, playId: 9, locked: false },
    ])
    expect(stats["1-2-base"]).toEqual({ owned: 2, locked: 1 })
    expect(stats["9-9-base"]).toEqual({ owned: 1, locked: 0 })
  })
})

describe("cosmetics", () => {
  it("resolves known cosmetic values, null for unknown/nullish", () => {
    expect(borderCosmetic("flame")?.label).toBe("Flame")
    expect(borderCosmetic("nonexistent")).toBeNull()
    expect(borderCosmetic(null)).toBeNull()
    expect(bannerCosmetic("ripcity")?.label).toBe("Rip City")
    expect(bannerCosmetic(undefined)).toBeNull()
  })
})
