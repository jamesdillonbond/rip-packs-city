// lib/sniper/serial-estimate.ts — the fitted serial model, not the flat 8x display multiplier,
// prices a #1 / perfect-serial sniper deal (2026-10-25). The live case: Pauline Astier Rookie
// Revelation #1/29 read "Adj. FMV $704 · -68.5%" (8 x $88) beside the badge "#1 est ≈ $189";
// at a $222 ask it is not a deal at all.

import { describe, expect, it } from "vitest"
import { applySerialFmvEstimates, type SerialEstimateDeal } from "@/lib/sniper/serial-estimate"

const deal = (over: Partial<SerialEstimateDeal> = {}): SerialEstimateDeal => ({
  askPrice: 222,
  baseFmv: 88,
  adjustedFmv: 704,
  discount: 68.5,
  dealRating: 0.6847,
  serialMult: 8,
  confidence: "high",
  serialFmvEstimate: { estimate_usd: 189 },
  ...over,
})

describe("applySerialFmvEstimates", () => {
  it("⛔ the Astier #1/29 case: an ask above the model estimate is no longer a deal", () => {
    expect(applySerialFmvEstimates([deal()], 0)).toEqual([])
  })

  it("re-prices a real deal from the estimate: adjustedFmv, discount, dealRating, serialMult", () => {
    const [d] = applySerialFmvEstimates([deal({ askPrice: 150 })], 0)
    expect(d.adjustedFmv).toBe(189)
    expect(d.discount).toBeCloseTo(20.6, 1)
    expect(d.dealRating).toBeCloseTo(1 - 150 / 189, 4)
    expect(d.serialMult).toBeCloseTo(189 / 88, 3)
  })

  it("drops a re-priced deal that falls under the caller's minDiscount", () => {
    expect(applySerialFmvEstimates([deal({ askPrice: 180 })], 10)).toEqual([])
  })

  it("leaves a deal with no estimate, or a LOW base, exactly as it was", () => {
    const none = deal({ serialFmvEstimate: null })
    const low = deal({ confidence: "low" })
    expect(applySerialFmvEstimates([none, low], 0)).toEqual([none, low])
  })

  it("ignores a non-positive or non-finite estimate", () => {
    const zero = deal({ serialFmvEstimate: { estimate_usd: 0 } })
    const nan = deal({ serialFmvEstimate: { estimate_usd: Number.NaN } })
    expect(applySerialFmvEstimates([zero, nan], 0)).toEqual([zero, nan])
  })
})
