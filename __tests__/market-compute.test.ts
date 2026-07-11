import { describe, it, expect } from "vitest"
import { computeFmv, isSpecialSerial } from "@/lib/market-compute"

// Locks in the FMV pricing core (lib/market-compute.ts::computeFmv) — the
// deterministic engine behind every price the site shows. These assertions
// pin the branch selection (marketSource / fmvMethod), the special-serial
// multiplier path, the standard band/low-ask/best-offer/last-sale ladder,
// the below-median serial power-law premium, and the fmv_snapshots fallback,
// so a refactor can't silently re-price moments.

function base(over: Partial<Parameters<typeof computeFmv>[0]> = {}) {
  return { momentId: "m1", ...over }
}

describe("isSpecialSerial", () => {
  it("returns false for nullish / non-array input", () => {
    expect(isSpecialSerial(null)).toBe(false)
    expect(isSpecialSerial(undefined)).toBe(false)
    // @ts-expect-error — guarding the runtime non-array path
    expect(isSpecialSerial("Jersey")).toBe(false)
  })

  it("matches only the exact confirmed GraphQL badge strings", () => {
    expect(isSpecialSerial(["#1 Serial"])).toBe(true)
    expect(isSpecialSerial(["Jersey"])).toBe(true)
    expect(isSpecialSerial(["Original Perfect Mint Serial"])).toBe(true)
    // Near-miss variants the code explicitly warns against must NOT match.
    expect(isSpecialSerial(["#1"])).toBe(false)
    expect(isSpecialSerial(["Jersey Match"])).toBe(false)
    expect(isSpecialSerial(["Perfect Mint"])).toBe(false)
  })
})

describe("computeFmv — standard serial path", () => {
  it("no market signals → fmv null, marketSource/fmvMethod 'none'", () => {
    const r = computeFmv(base())
    expect(r.fmv).toBeNull()
    expect(r.marketSource).toBe("none")
    expect(r.fmvMethod).toBe("none")
  })

  it("low ask + best offer → band midpoint, method 'band'", () => {
    const r = computeFmv(base({ lowAsk: 100, bestOffer: 60 }))
    // midpoint 80, clamped to [60, 100] → 80
    expect(r.fmv).toBe(80)
    expect(r.fmvMethod).toBe("band")
    expect(r.marketSource).toBe("row")
  })

  it("band clamps the midpoint into [bestOffer, lowAsk]", () => {
    // Inverted inputs (offer above ask) exercise the clamp guards.
    const r = computeFmv(base({ lowAsk: 50, bestOffer: 200 }))
    // midpoint 125 → min(50,125)=50 → max(200,50)=200
    expect(r.fmv).toBe(200)
    expect(r.fmvMethod).toBe("band")
  })

  it("low ask only → method 'low-ask-only'", () => {
    const r = computeFmv(base({ lowAsk: 42 }))
    expect(r.fmv).toBe(42)
    expect(r.fmvMethod).toBe("low-ask-only")
  })

  it("best offer only → method 'best-offer-only'", () => {
    const r = computeFmv(base({ bestOffer: 33 }))
    expect(r.fmv).toBe(33)
    expect(r.fmvMethod).toBe("best-offer-only")
  })

  it("edition last sale only → 0.80 time-decay discount, marketSource 'edition-sale'", () => {
    const r = computeFmv(base({ editionLastSale: 100 }))
    expect(r.fmv).toBe(80)
    expect(r.fmvMethod).toBe("edition-last-sale")
    expect(r.marketSource).toBe("edition-sale")
  })

  it("merges row + edition asks, taking the lower ask", () => {
    const r = computeFmv(base({ lowAsk: 90, editionLowAsk: 70 }))
    expect(r.lowAsk).toBe(70)
    expect(r.fmv).toBe(70)
    expect(r.marketSource).toBe("row+edition")
  })
})

describe("computeFmv — fmv_snapshots fallback", () => {
  it("falls back to fmvUsd when no live market data produced an fmv", () => {
    const r = computeFmv(base({ fmvUsd: 25 }))
    expect(r.fmv).toBe(25)
    expect(r.fmvMethod).toBe("low-ask-only")
    expect(r.marketSource).toBe("edition")
  })

  it("does NOT fall back when live market data already priced the moment", () => {
    const r = computeFmv(base({ lowAsk: 10, fmvUsd: 999 }))
    expect(r.fmv).toBe(10)
    expect(r.marketSource).toBe("row")
  })
})

describe("computeFmv — special serial path", () => {
  it("applies the #1 Serial multiplier (12×) to the edition floor", () => {
    const r = computeFmv(
      base({ editionLowAsk: 10, specialSerialTraits: ["#1 Serial"] })
    )
    expect(r.isSpecialSerial).toBe(true)
    expect(r.serialMultiplier).toBe(12)
    expect(r.fmv).toBe(120)
    expect(r.fmvMethod).toBe("special-serial-premium")
    expect(r.marketSource).toBe("special-serial")
  })

  it("#1 Serial takes priority over Jersey when both present", () => {
    const r = computeFmv(
      base({ editionLowAsk: 10, specialSerialTraits: ["Jersey", "#1 Serial"] })
    )
    expect(r.serialMultiplier).toBe(12)
  })

  it("Jersey uses the 8× multiplier", () => {
    const r = computeFmv(
      base({ editionLowAsk: 10, specialSerialTraits: ["Jersey"] })
    )
    expect(r.serialMultiplier).toBe(8)
    expect(r.fmv).toBe(80)
  })

  it("special serial with no priceable base stays null", () => {
    const r = computeFmv(base({ specialSerialTraits: ["#1 Serial"] }))
    expect(r.isSpecialSerial).toBe(true)
    expect(r.fmv).toBeNull()
  })
})

describe("computeFmv — serial power-law premium", () => {
  it("below-median serial on a small edition gets a premium (>base)", () => {
    const r = computeFmv(
      base({
        lowAsk: 100,
        serialNumber: 1,
        circulationCount: 100,
        tier: "Common",
      })
    )
    expect(r.serialMultiplier).toBeGreaterThan(1)
    expect(r.fmv).toBeGreaterThan(100)
    expect(r.fmvMethod).toBe("serial-power-law")
  })

  it("above-median serial gets no premium (multiplier stays 1.0)", () => {
    const r = computeFmv(
      base({
        lowAsk: 100,
        serialNumber: 90,
        circulationCount: 100,
        tier: "Common",
      })
    )
    expect(r.serialMultiplier).toBe(1)
    expect(r.fmv).toBe(100)
    expect(r.fmvMethod).toBe("low-ask-only")
  })

  it("rounds fmv to 2 decimals", () => {
    const r = computeFmv(
      base({
        lowAsk: 100,
        serialNumber: 1,
        circulationCount: 100,
        tier: "Ultimate",
      })
    )
    expect(r.fmv).not.toBeNull()
    // no more than 2 decimal places
    expect(Number.isInteger(Number((r.fmv! * 100).toFixed(0)))).toBe(true)
  })
})

describe("computeFmv — valuation scope", () => {
  it("parallel input → scope 'Parallel'", () => {
    const r = computeFmv(base({ parallel: "Hexwave", lowAsk: 5 }))
    expect(r.valuationScope).toBe("Parallel")
    expect(r.normalizedParallel).toBe("Hexwave")
  })

  it("editionKey but no parallel → scope 'Edition' and normalized 'Base'", () => {
    const r = computeFmv(base({ editionKey: "73:2785", lowAsk: 5 }))
    expect(r.valuationScope).toBe("Edition")
    expect(r.normalizedParallel).toBe("Base")
  })

  it("neither → scope 'Modeled'", () => {
    const r = computeFmv(base({ lowAsk: 5 }))
    expect(r.valuationScope).toBe("Modeled")
  })
})
