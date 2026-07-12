import { describe, it, expect } from "vitest"
import { computeFMV } from "@/lib/fmv-engine"

// Unit tests for lib/fmv-engine.ts computeFMV — the ask/offer band FMV used when
// no sales-based FMV exists. Previously untested. It encodes two disciplines:
//   - non-special serials: FMV is the ask/offer midpoint, CLAMPED into the
//     [bestOffer, lowAsk] band so an inverted book (offer above ask) can't push
//     FMV past the ask.
//   - special serials: a flat 1.5x premium over the base ask (or offer).
// It also treats 0 / missing as "no data" (falsy), which callers rely on.

describe("computeFMV — non-special serials", () => {
  it("returns null when neither an ask nor an offer is present", () => {
    expect(computeFMV({})).toBeNull()
    // 0 is treated as absent (falsy), not a real price.
    expect(computeFMV({ lowAsk: 0, bestOffer: 0 })).toBeNull()
  })

  it("uses the offer alone when there is no ask", () => {
    expect(computeFMV({ bestOffer: 40 })).toBe(40)
  })

  it("uses the ask alone when there is no offer", () => {
    expect(computeFMV({ lowAsk: 60 })).toBe(60)
  })

  it("returns the midpoint when ask and offer bracket normally (offer < ask)", () => {
    // mid of 10 and 20 = 15, inside [10, 20] → 15.
    expect(computeFMV({ lowAsk: 20, bestOffer: 10 })).toBe(15)
  })

  it("clamps to the ask when the offer sits ABOVE the ask (inverted book)", () => {
    // lowAsk 10, bestOffer 20, mid 15 → min(10, max(20,15)) = min(10,20) = 10.
    expect(computeFMV({ lowAsk: 10, bestOffer: 20 })).toBe(10)
  })

  it("never exceeds the ask nor falls below the offer for a normal book", () => {
    const lowAsk = 100
    const bestOffer = 30
    const fmv = computeFMV({ lowAsk, bestOffer })!
    expect(fmv).toBeGreaterThanOrEqual(bestOffer)
    expect(fmv).toBeLessThanOrEqual(lowAsk)
  })
})

describe("computeFMV — special serials", () => {
  it("applies a 1.5x premium over the ask", () => {
    expect(computeFMV({ lowAsk: 100, isSpecialSerial: true })).toBe(150)
  })

  it("prefers the ask over the offer as the premium base", () => {
    // base = lowAsk (100), not bestOffer (10) → 150, not 15.
    expect(computeFMV({ lowAsk: 100, bestOffer: 10, isSpecialSerial: true })).toBe(150)
  })

  it("falls back to the offer as the base when no ask exists", () => {
    expect(computeFMV({ bestOffer: 80, isSpecialSerial: true })).toBe(120)
  })

  it("still returns null when there is no price data at all", () => {
    expect(computeFMV({ isSpecialSerial: true })).toBeNull()
  })
})
