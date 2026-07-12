import { describe, it, expect } from "vitest"
import { computeDualPrice } from "@/lib/pack-ev-pricing"

// Unit tests for the pack-EV dual-price anchor selection (lib/pack-ev-pricing.ts,
// extracted from app/api/pack-ev/route.ts and ported verbatim into the
// compute-*-pack-ev edge functions). The chosen anchor becomes the EV
// denominator, so mis-picking it silently corrupts every EV ratio for a pack —
// exactly the class of bug the route note warns about (Series-1 EV going
// meaningless once primary sells out). Previously untested.

describe("computeDualPrice anchor selection", () => {
  it("uses primary when only a live primary listing exists", () => {
    const d = computeDualPrice({ requestedPrice: 25, totalUnopened: 100, forSale: true, secondaryAsk: null })
    expect(d.priceSource).toBe("primary")
    expect(d.packPrice).toBe(25)
    expect(d.primaryAvailable).toBe(true)
    expect(d.secondaryAvailable).toBe(false)
  })

  it("uses secondary when primary is sold out but a P2P ask exists", () => {
    // totalUnopened 0 → no primary; the secondary ask becomes the anchor.
    const d = computeDualPrice({ requestedPrice: 25, totalUnopened: 0, forSale: true, secondaryAsk: 9 })
    expect(d.priceSource).toBe("secondary")
    expect(d.packPrice).toBe(9)
    expect(d.primaryPrice).toBeNull()
  })

  it("picks the cheaper of primary vs secondary when both are live", () => {
    const cheaperSecondary = computeDualPrice({ requestedPrice: 25, totalUnopened: 50, forSale: true, secondaryAsk: 10 })
    expect(cheaperSecondary.priceSource).toBe("secondary")
    expect(cheaperSecondary.packPrice).toBe(10)

    const cheaperPrimary = computeDualPrice({ requestedPrice: 8, totalUnopened: 50, forSale: true, secondaryAsk: 20 })
    expect(cheaperPrimary.priceSource).toBe("primary")
    expect(cheaperPrimary.packPrice).toBe(8)
  })

  it("labels the anchor 'min' when primary and secondary are within 1%", () => {
    const d = computeDualPrice({ requestedPrice: 100, totalUnopened: 50, forSale: true, secondaryAsk: 100.5 })
    expect(d.priceSource).toBe("min")
    // Still buys at the cheaper of the two.
    expect(d.packPrice).toBe(100)
  })

  it("reports 'none' and a zero pack price when nothing is buyable", () => {
    const d = computeDualPrice({ requestedPrice: 25, totalUnopened: 0, forSale: false, secondaryAsk: null })
    expect(d.priceSource).toBe("none")
    expect(d.packPrice).toBe(0)
  })

  it("treats a listing that is not forSale as no primary, even with unopened supply", () => {
    const d = computeDualPrice({ requestedPrice: 25, totalUnopened: 100, forSale: false, secondaryAsk: null })
    expect(d.primaryAvailable).toBe(false)
    expect(d.priceSource).toBe("none")
  })

  it("ignores a non-positive secondary ask", () => {
    const d = computeDualPrice({ requestedPrice: 0, totalUnopened: 0, forSale: true, secondaryAsk: 0 })
    expect(d.secondaryAvailable).toBe(false)
    expect(d.priceSource).toBe("none")
  })

  it("ignores a zero requested price on the primary leg", () => {
    // forSale + supply but requestedPrice 0 → primaryPrice null, falls to secondary.
    const d = computeDualPrice({ requestedPrice: 0, totalUnopened: 100, forSale: true, secondaryAsk: 15 })
    expect(d.primaryPrice).toBeNull()
    expect(d.priceSource).toBe("secondary")
    expect(d.packPrice).toBe(15)
  })
})
