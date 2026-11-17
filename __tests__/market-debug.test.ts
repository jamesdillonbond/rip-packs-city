import { describe, it, expect } from "vitest"
import { explainMarketBlankState } from "@/lib/market-debug"

// lib/market-debug.ts classifies WHY an edition renders no market — the reason
// code behind a blank FMV strip. Special serials have their own branch (a base
// with no inputs is expected, not an error).

describe("explainMarketBlankState — non-special serials", () => {
  it("OK when both ask and offer exist", () => {
    expect(explainMarketBlankState({ lowAsk: 10, bestOffer: 5, isSpecialSerial: false })).toBe("OK")
  })

  it("NO_MARKET_INPUTS when neither ask nor offer exists", () => {
    expect(explainMarketBlankState({ lowAsk: null, bestOffer: null, isSpecialSerial: false })).toBe("NO_MARKET_INPUTS")
  })

  it("NO_LOW_ASK when only an offer exists", () => {
    expect(explainMarketBlankState({ lowAsk: null, bestOffer: 5, isSpecialSerial: false })).toBe("NO_LOW_ASK")
  })

  it("NO_BEST_OFFER when only an ask exists", () => {
    expect(explainMarketBlankState({ lowAsk: 10, bestOffer: null, isSpecialSerial: false })).toBe("NO_BEST_OFFER")
  })
})

describe("explainMarketBlankState — special serials", () => {
  it("SPECIAL_SERIAL_NO_BASE when a special serial has no ask, offer, or last purchase", () => {
    expect(
      explainMarketBlankState({ lowAsk: null, bestOffer: null, isSpecialSerial: true, lastPurchasePrice: null }),
    ).toBe("SPECIAL_SERIAL_NO_BASE")
  })

  it("OK for a special serial with any market anchor (a last purchase counts)", () => {
    expect(
      explainMarketBlankState({ lowAsk: null, bestOffer: null, isSpecialSerial: true, lastPurchasePrice: 250 }),
    ).toBe("OK")
    expect(explainMarketBlankState({ lowAsk: 500, bestOffer: null, isSpecialSerial: true })).toBe("OK")
  })
})
