import { describe, it, expect } from "vitest"
import { selectCrossMarketFloor } from "@/lib/cross-market-floor"

// Unit tests for the cross-market floor selection extracted from
// app/api/edition-floor/route.ts. This decides the real-time lowest ask a buyer
// pays across Top Shot + Flowty (and which venue it came from), feeding
// fmv_snapshots.cross_market_ask — a mis-pick misreports the market floor.

describe("selectCrossMarketFloor", () => {
  it("picks the lower floor and tags its source when both venues have one", () => {
    expect(selectCrossMarketFloor(10, 15)).toEqual({ crossMarketFloor: 10, crossMarketSource: "topshot" })
    expect(selectCrossMarketFloor(20, 12)).toEqual({ crossMarketFloor: 12, crossMarketSource: "flowty" })
  })

  it("breaks a tie in favor of Top Shot (native venue, <=)", () => {
    expect(selectCrossMarketFloor(14, 14)).toEqual({ crossMarketFloor: 14, crossMarketSource: "topshot" })
  })

  it("uses the only venue with a floor when the other is null", () => {
    expect(selectCrossMarketFloor(9, null)).toEqual({ crossMarketFloor: 9, crossMarketSource: "topshot" })
    expect(selectCrossMarketFloor(null, 7)).toEqual({ crossMarketFloor: 7, crossMarketSource: "flowty" })
  })

  it("returns a null floor with no source when neither venue has an ask", () => {
    expect(selectCrossMarketFloor(null, null)).toEqual({ crossMarketFloor: null, crossMarketSource: null })
  })

  it("treats a null floor as absent, not as a zero that would win", () => {
    // A null TS floor must not beat a real Flowty floor of 5.
    expect(selectCrossMarketFloor(null, 5)).toEqual({ crossMarketFloor: 5, crossMarketSource: "flowty" })
  })
})
