import { describe, it, expect } from "vitest"
import { TIER_RARITY_ORDER, sumPoolRemaining, orderedTiersWithSupply, pctOfPoolLabel, deriveDualPrice } from "@/lib/pack-dist-odds"

describe("pack-dist-odds — sumPoolRemaining", () => {
  it("sums remaining across tiers, coercing non-numbers to 0", () => {
    expect(sumPoolRemaining({ common: 100, rare: 20, legendary: 5 })).toBe(125)
    expect(sumPoolRemaining({ common: 10, bad: NaN as unknown as number })).toBe(10)
  })
  it("is 0 for an empty pool", () => {
    expect(sumPoolRemaining({})).toBe(0)
  })
})

describe("pack-dist-odds — orderedTiersWithSupply", () => {
  it("orders standard tiers by rarity and drops zero-supply tiers", () => {
    const out = orderedTiersWithSupply({ common: 100, legendary: 5, rare: 0, ultimate: 1 })
    expect(out).toEqual(["ultimate", "legendary", "common"])
  })
  it("appends non-standard tiers with supply after the standard ones, in key order", () => {
    const out = orderedTiersWithSupply({ legendary: 2, mythic: 3, chase: 1 })
    expect(out).toEqual(["legendary", "mythic", "chase"])
  })
  it("returns [] when nothing has supply", () => {
    expect(orderedTiersWithSupply({ common: 0, rare: 0 })).toEqual([])
  })
  it("TIER_RARITY_ORDER puts ultimate first, common last", () => {
    expect(TIER_RARITY_ORDER[0]).toBe("ultimate")
    expect(TIER_RARITY_ORDER[TIER_RARITY_ORDER.length - 1]).toBe("common")
  })
})

describe("pack-dist-odds — pctOfPoolLabel", () => {
  it("returns em-dash when the pool is empty (null pct)", () => {
    expect(pctOfPoolLabel(5, 0)).toBe("—")
  })
  it("returns <0.1% for a tiny positive share", () => {
    // 1 / 2000 = 0.05%
    expect(pctOfPoolLabel(1, 2000)).toBe("<0.1%")
  })
  it("uses 1 decimal below 10%", () => {
    // 5 / 100 = 5.0%
    expect(pctOfPoolLabel(5, 100)).toBe("5.0%")
  })
  it("uses 0 decimals at/above 10%", () => {
    // 25 / 100 = 25%
    expect(pctOfPoolLabel(25, 100)).toBe("25%")
  })
  it("returns 0.0% for a zero share of a non-empty pool", () => {
    expect(pctOfPoolLabel(0, 100)).toBe("0.0%")
  })
})

describe("pack-dist-odds — deriveDualPrice", () => {
  const base = {
    primaryPrice: 10,
    secondaryAsk: 12,
    primaryAvailable: true,
    secondaryAvailable: true,
  }
  it("flags the legacy single-line fallback when priceSource is null", () => {
    const d = deriveDualPrice({ ...base, priceSource: null })
    expect(d.legacy).toBe(true)
    expect(d).toMatchObject({ primaryLive: false, secondaryLive: false, primaryAnchor: false, secondaryAnchor: false })
  })
  it("marks a leg live only when available, non-null, and > 0", () => {
    expect(deriveDualPrice({ ...base, priceSource: "primary" }).primaryLive).toBe(true)
    expect(deriveDualPrice({ ...base, primaryPrice: 0, priceSource: "primary" }).primaryLive).toBe(false)
    expect(deriveDualPrice({ ...base, primaryAvailable: false, priceSource: "primary" }).primaryLive).toBe(false)
    expect(deriveDualPrice({ ...base, secondaryAsk: null, priceSource: "secondary" }).secondaryLive).toBe(false)
  })
  it("anchors the primary leg for source 'primary' and 'min'", () => {
    expect(deriveDualPrice({ ...base, priceSource: "primary" })).toMatchObject({ primaryAnchor: true, secondaryAnchor: false })
    expect(deriveDualPrice({ ...base, priceSource: "min" })).toMatchObject({ primaryAnchor: true, secondaryAnchor: true })
  })
  it("anchors only the secondary leg for source 'secondary'", () => {
    expect(deriveDualPrice({ ...base, priceSource: "secondary" })).toMatchObject({ primaryAnchor: false, secondaryAnchor: true })
  })
  it("anchors neither leg for source 'none'", () => {
    expect(deriveDualPrice({ ...base, priceSource: "none" })).toMatchObject({ primaryAnchor: false, secondaryAnchor: false, legacy: false })
  })
})
