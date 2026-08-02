import { describe, it, expect } from "vitest"
import {
  SENTINEL_PRICES,
  isSentinelPrice,
  isHoldingPackName,
  isClampedEvNet,
  detectHoldingPack,
  deriveSecondaryAskAnchor,
  deriveEvVerdict,
  isEvInflatedVsAsk,
  isSurvivorBiased,
} from "@/lib/pack-dist-verdict"

describe("isSentinelPrice", () => {
  it("matches the three canonical escrow sentinels", () => {
    for (const p of [9999, 99999, 999999]) expect(isSentinelPrice(p)).toBe(true)
    expect(SENTINEL_PRICES.size).toBe(3)
  })
  it("rejects real prices and null/undefined", () => {
    expect(isSentinelPrice(10)).toBe(false)
    expect(isSentinelPrice(0)).toBe(false)
    expect(isSentinelPrice(10000)).toBe(false)
    expect(isSentinelPrice(null)).toBe(false)
    expect(isSentinelPrice(undefined)).toBe(false)
  })
})

describe("isHoldingPackName", () => {
  it("matches hold / holding / holder as whole words, case-insensitive", () => {
    expect(isHoldingPackName("Holding Pack")).toBe(true)
    expect(isHoldingPackName("player holder")).toBe(true)
    expect(isHoldingPackName("HOLD")).toBe(true)
  })
  it("does not match substrings inside other words", () => {
    expect(isHoldingPackName("Household Legends")).toBe(false)
    expect(isHoldingPackName("Stronghold")).toBe(false)
    expect(isHoldingPackName("Base Set Pack")).toBe(false)
  })
  it("tolerates null/undefined", () => {
    expect(isHoldingPackName(null)).toBe(false)
    expect(isHoldingPackName(undefined)).toBe(false)
  })
})

describe("isClampedEvNet", () => {
  it("fires at or below the -10000 floor", () => {
    expect(isClampedEvNet(-10000)).toBe(true)
    expect(isClampedEvNet(-25000)).toBe(true)
  })
  it("does not fire above the floor or on null", () => {
    expect(isClampedEvNet(-9999.99)).toBe(false)
    expect(isClampedEvNet(-500)).toBe(false)
    expect(isClampedEvNet(0)).toBe(false)
    expect(isClampedEvNet(null)).toBe(false)
    expect(isClampedEvNet(undefined)).toBe(false)
  })
})

describe("detectHoldingPack", () => {
  it("fires on a holding name alone", () => {
    expect(detectHoldingPack({ title: "Holder Reserve" })).toBe(true)
  })
  it("fires on a clamped net even with a normal name/price", () => {
    expect(
      detectHoldingPack({ title: "Series 4 Pack", packEvNet: -10000, prices: [10, 12] }),
    ).toBe(true)
  })
  it("fires on any sentinel price in the list", () => {
    expect(detectHoldingPack({ title: "Pack", prices: [null, 99999] })).toBe(true)
    expect(detectHoldingPack({ title: "Pack", prices: [999999] })).toBe(true)
  })
  it("is false for a normal consumer pack", () => {
    expect(
      detectHoldingPack({ title: "Base Set", packEvNet: -3, prices: [10, 14] }),
    ).toBe(false)
  })
  it("ignores an omitted prices array", () => {
    expect(detectHoldingPack({ title: "Base Set" })).toBe(false)
  })
})

describe("deriveSecondaryAskAnchor", () => {
  it("returns the ask only when available and positive", () => {
    expect(deriveSecondaryAskAnchor(true, 42)).toBe(42)
  })
  it("is null when not available", () => {
    expect(deriveSecondaryAskAnchor(false, 42)).toBeNull()
    expect(deriveSecondaryAskAnchor(null, 42)).toBeNull()
    expect(deriveSecondaryAskAnchor(undefined, 42)).toBeNull()
  })
  it("is null on a zero / negative / null ask", () => {
    expect(deriveSecondaryAskAnchor(true, 0)).toBeNull()
    expect(deriveSecondaryAskAnchor(true, -5)).toBeNull()
    expect(deriveSecondaryAskAnchor(true, null)).toBeNull()
  })
})

describe("deriveEvVerdict", () => {
  it("computes net/ratio/margin and rounds net to cents", () => {
    const v = deriveEvVerdict(15.005, 10)
    expect(v.packEv).toBe(5.01) // round((15.005-10)*100)/100 = round(500.5)/100
    expect(v.valueRatio).toBeCloseTo(1.5005, 6)
    expect(v.evMargin).toBeCloseTo(50.05, 6)
    expect(v.isPositive).toBe(true)
  })
  it("marks a below-ask pack as non-positive with a negative net", () => {
    const v = deriveEvVerdict(8, 10)
    expect(v.packEv).toBe(-2)
    expect(v.valueRatio).toBe(0.8)
    expect(v.evMargin).toBeCloseTo(-20, 6)
    expect(v.isPositive).toBe(false)
  })
  it("returns all-null / non-positive when the anchor is missing", () => {
    const v = deriveEvVerdict(100, null)
    expect(v.packEv).toBeNull()
    expect(v.valueRatio).toBeNull()
    expect(v.evMargin).toBeNull()
    expect(v.isPositive).toBe(false)
  })
  it("returns all-null when grossEv is missing", () => {
    const v = deriveEvVerdict(null, 10)
    expect(v.packEv).toBeNull()
    expect(v.valueRatio).toBeNull()
    expect(v.evMargin).toBeNull()
  })
  it("net exactly at zero is not positive", () => {
    expect(deriveEvVerdict(10, 10).isPositive).toBe(false)
  })
})

describe("isEvInflatedVsAsk", () => {
  it("fires when gross EV exceeds 3x a live secondary ask", () => {
    expect(
      isEvInflatedVsAsk({ secondaryAvailable: true, secondaryAsk: 10, grossEv: 31 }),
    ).toBe(true)
  })
  it("does not fire at exactly 3x (strict >)", () => {
    expect(
      isEvInflatedVsAsk({ secondaryAvailable: true, secondaryAsk: 10, grossEv: 30 }),
    ).toBe(false)
  })
  it("requires an available, positive ask", () => {
    expect(isEvInflatedVsAsk({ secondaryAvailable: false, secondaryAsk: 10, grossEv: 100 })).toBe(false)
    expect(isEvInflatedVsAsk({ secondaryAvailable: true, secondaryAsk: 0, grossEv: 100 })).toBe(false)
    expect(isEvInflatedVsAsk({ secondaryAvailable: true, secondaryAsk: null, grossEv: 100 })).toBe(false)
    expect(isEvInflatedVsAsk({ secondaryAvailable: true, secondaryAsk: 10, grossEv: null })).toBe(false)
  })
})

describe("isSurvivorBiased", () => {
  const base = {
    useCorrectedEv: false,
    depletionPct: 0,
    secondaryAvailable: false as boolean,
    secondaryAsk: null as number | null,
    grossEv: 5 as number | null,
    hasDropPool: true,
  }
  it("fires on a ≥90% depleted pool", () => {
    expect(isSurvivorBiased({ ...base, depletionPct: 90 })).toBe(true)
    expect(isSurvivorBiased({ ...base, depletionPct: 95 })).toBe(true)
  })
  it("does not fire just below 90% depletion with no ask inflation", () => {
    expect(isSurvivorBiased({ ...base, depletionPct: 89.9 })).toBe(false)
  })
  it("fires on ask inflation even at low depletion", () => {
    expect(
      isSurvivorBiased({ ...base, depletionPct: 10, secondaryAvailable: true, secondaryAsk: 10, grossEv: 40 }),
    ).toBe(true)
  })
  it("is suppressed when the EV is AllDay-corrected", () => {
    expect(isSurvivorBiased({ ...base, useCorrectedEv: true, depletionPct: 99 })).toBe(false)
  })
  it("is suppressed when there is no drop pool (page path)", () => {
    expect(isSurvivorBiased({ ...base, hasDropPool: false, depletionPct: 99 })).toBe(false)
  })
  it("defaults hasDropPool to true so the SEO path (no pool signal) still gates", () => {
    // SEO omits hasDropPool entirely — byte-identical to the old inline gate
    // which had no pool factor.
    expect(
      isSurvivorBiased({
        useCorrectedEv: false,
        depletionPct: 92,
        secondaryAvailable: false,
        secondaryAsk: null,
        grossEv: 5,
      }),
    ).toBe(true)
  })
})
