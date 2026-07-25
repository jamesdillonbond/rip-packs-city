import { describe, it, expect } from "vitest"
import {
  momentTierColor,
  momentTierBgClass,
  momentHoloClass,
  computeMomentPnl,
  pnlColorClass,
  resolveMomentPnlBasis,
  resolveMomentBestOffer,
  computeAskFmvDelta,
  shouldShowAskBadge,
} from "@/lib/collection-moment-cells"

// Pins the pure per-row display/math logic lifted out of
// components/collection/CollectionMomentTable.tsx (invisible to the coverage
// ratchet). A regression here mis-colors tiers, mis-computes P&L, surfaces the
// wrong best offer, or wrongly shows/hides the ask-vs-FMV chips.

describe("momentTierColor", () => {
  it("maps known tiers (case-insensitive)", () => {
    expect(momentTierColor("COMMON")).toBe("#9ca3af")
    expect(momentTierColor("common")).toBe("#9ca3af")
    expect(momentTierColor("UNCOMMON")).toBe("#14b8a6")
    expect(momentTierColor("Fandom")).toBe("#60a5fa")
    expect(momentTierColor("RARE")).toBe("#38bdf8")
    expect(momentTierColor("LEGENDARY")).toBe("#fbbf24")
    expect(momentTierColor("ULTIMATE")).toBe("#c084fc")
  })
  it("falls back to gray for unknown/null/undefined", () => {
    expect(momentTierColor("MYTHIC")).toBe("#9ca3af")
    expect(momentTierColor(null)).toBe("#9ca3af")
    expect(momentTierColor(undefined)).toBe("#9ca3af")
    expect(momentTierColor("")).toBe("#9ca3af")
  })
})

describe("momentTierBgClass", () => {
  it("maps known tiers", () => {
    expect(momentTierBgClass("COMMON")).toBe("bg-[var(--rpc-surface-raised)]")
    expect(momentTierBgClass("uncommon")).toBe("bg-teal-950")
    expect(momentTierBgClass("FANDOM")).toBe("bg-blue-950")
    expect(momentTierBgClass("RARE")).toBe("bg-sky-950")
    expect(momentTierBgClass("LEGENDARY")).toBe("bg-yellow-950")
    expect(momentTierBgClass("ULTIMATE")).toBe("bg-purple-950")
  })
  it("falls back to the surface class for unknown/null", () => {
    expect(momentTierBgClass("MYTHIC")).toBe("bg-[var(--rpc-surface-raised)]")
    expect(momentTierBgClass(null)).toBe("bg-[var(--rpc-surface-raised)]")
    expect(momentTierBgClass(undefined)).toBe("bg-[var(--rpc-surface-raised)]")
  })
})

describe("momentHoloClass", () => {
  it("only the three rarest tiers get a holo class", () => {
    expect(momentHoloClass("LEGENDARY")).toBe("rpc-holo-legendary")
    expect(momentHoloClass("ultimate")).toBe("rpc-holo-ultimate")
    expect(momentHoloClass("RARE")).toBe("rpc-holo-rare")
  })
  it("everything else is empty", () => {
    expect(momentHoloClass("COMMON")).toBe("")
    expect(momentHoloClass("FANDOM")).toBe("")
    expect(momentHoloClass(null)).toBe("")
    expect(momentHoloClass(undefined)).toBe("")
    expect(momentHoloClass("")).toBe("")
  })
})

describe("computeMomentPnl", () => {
  it("positive gain", () => {
    expect(computeMomentPnl(150, 100)).toEqual({ pl: 50, plPct: 50, positive: true })
  })
  it("loss", () => {
    expect(computeMomentPnl(80, 100)).toEqual({ pl: -20, plPct: -20, positive: false })
  })
  it("break-even is positive (>= 0)", () => {
    expect(computeMomentPnl(100, 100)).toEqual({ pl: 0, plPct: 0, positive: true })
  })
  it("basis of 0 yields plPct 0 (guards the divide-by-zero branch)", () => {
    expect(computeMomentPnl(40, 0)).toEqual({ pl: 40, plPct: 0, positive: true })
  })
})

describe("pnlColorClass", () => {
  it("positive → emerald, negative → red", () => {
    expect(pnlColorClass(true)).toBe("text-emerald-400")
    expect(pnlColorClass(false)).toBe("text-red-400")
  })
})

describe("resolveMomentPnlBasis", () => {
  it("uses a positive Bought/Loan cost basis", () => {
    expect(resolveMomentPnlBasis("Bought", 42, 99)).toBe(42)
    expect(resolveMomentPnlBasis("Loan", 30, 99)).toBe(30)
  })
  it("falls back to last purchase price when the cost basis is non-positive or a non-Bought/Loan label", () => {
    expect(resolveMomentPnlBasis("Bought", 0, 77)).toBe(77)
    expect(resolveMomentPnlBasis("Pack", 55, 77)).toBe(77)
    expect(resolveMomentPnlBasis(null, 55, 77)).toBe(77)
    expect(resolveMomentPnlBasis(undefined, undefined, 77)).toBe(77)
  })
  it("returns 0 when nothing qualifies", () => {
    expect(resolveMomentPnlBasis("Gift", 55, null)).toBe(0)
    expect(resolveMomentPnlBasis("Bought", 0, 0)).toBe(0)
    expect(resolveMomentPnlBasis(null, null, undefined)).toBe(0)
    expect(resolveMomentPnlBasis("Bought", null, -5)).toBe(0)
  })
})

describe("resolveMomentBestOffer", () => {
  it("prefers the higher of serial vs edition offer", () => {
    expect(resolveMomentBestOffer({ bestOffer: 60, editionOffer: 40, bestOfferType: "serial" })).toEqual({ val: 60, label: "serial" })
    expect(resolveMomentBestOffer({ bestOffer: 30, editionOffer: 80 })).toEqual({ val: 80, label: "edition" })
  })
  it("a tie goes to the serial offer (>=), defaulting the label", () => {
    expect(resolveMomentBestOffer({ bestOffer: 50, editionOffer: 50, bestOfferType: null })).toEqual({ val: 50, label: "serial" })
  })
  it("only a serial offer → uses bestOfferType or 'offer'", () => {
    expect(resolveMomentBestOffer({ bestOffer: 25, bestOfferType: "serial" })).toEqual({ val: 25, label: "serial" })
    expect(resolveMomentBestOffer({ bestOffer: 25 })).toEqual({ val: 25, label: "offer" })
  })
  it("only an edition offer, or only the denormalized editionBestOffer", () => {
    expect(resolveMomentBestOffer({ editionOffer: 15 })).toEqual({ val: 15, label: "edition" })
    expect(resolveMomentBestOffer({ editionBestOffer: 12 })).toEqual({ val: 12, label: "edition" })
  })
  it("ignores non-positive / non-numeric values and returns null when nothing qualifies", () => {
    expect(resolveMomentBestOffer({ bestOffer: 0, editionOffer: -5, editionBestOffer: null })).toBeNull()
    expect(resolveMomentBestOffer({})).toBeNull()
    expect(resolveMomentBestOffer({ bestOffer: null, editionOffer: undefined })).toBeNull()
  })
})

describe("computeAskFmvDelta", () => {
  it("null when unpriced / no valid fmv / no low ask", () => {
    expect(computeAskFmvDelta("none", 100, 90)).toBeNull()
    expect(computeAskFmvDelta("high", null, 90)).toBeNull()
    expect(computeAskFmvDelta("high", 0, 90)).toBeNull()
    expect(computeAskFmvDelta("high", -10, 90)).toBeNull()
    expect(computeAskFmvDelta("high", 100, null)).toBeNull()
    expect(computeAskFmvDelta("high", 100, undefined)).toBeNull()
  })
  it("null when the swing is under 3%", () => {
    expect(computeAskFmvDelta("high", 100, 102)).toBeNull()
    expect(computeAskFmvDelta("high", 100, 98)).toBeNull()
  })
  it("negative delta (ask below FMV) → emerald, ↓", () => {
    expect(computeAskFmvDelta("high", 100, 90)).toEqual({ pct: -10, colorClass: "text-emerald-400", label: "↓-10%" })
  })
  it("positive delta (ask above FMV) → red, ↑+", () => {
    expect(computeAskFmvDelta("medium", 100, 110)).toEqual({ pct: 10, colorClass: "text-red-400", label: "↑+10%" })
  })
})

describe("shouldShowAskBadge", () => {
  it("false when ask is missing or fmv is non-positive", () => {
    expect(shouldShowAskBadge(null, 100)).toBe(false)
    expect(shouldShowAskBadge(undefined, 100)).toBe(false)
    expect(shouldShowAskBadge(50, null)).toBe(false)
    expect(shouldShowAskBadge(50, 0)).toBe(false)
    expect(shouldShowAskBadge(50, -1)).toBe(false)
  })
  it("false when ask and fmv diverge by 1% or less", () => {
    expect(shouldShowAskBadge(100.5, 100)).toBe(false)
    expect(shouldShowAskBadge(100, 100)).toBe(false)
  })
  it("true when they diverge by more than 1% (either direction)", () => {
    expect(shouldShowAskBadge(105, 100)).toBe(true)
    expect(shouldShowAskBadge(95, 100)).toBe(true)
  })
})
