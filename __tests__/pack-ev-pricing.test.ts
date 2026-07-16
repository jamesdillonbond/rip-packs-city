import { describe, it, expect } from "vitest"
import { computeDualPrice, bestPrice, serialPremiumLabel } from "@/lib/pack-ev-pricing"

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

describe("bestPrice — per-edition FMV fallback ladder", () => {
  const node = (over: Partial<Parameters<typeof bestPrice>[0]> = {}) => ({
    averageSalePrice: 0,
    lowAsk: 0,
    lastPurchasePrice: 0,
    edition: { marketplaceInfo: { averageSaleData: { averagePrice: "0" } } },
    ...over,
  })

  it("rpc FMV wins above every other signal", () => {
    const r = bestPrice(node({ averageSalePrice: 50, lowAsk: 40, lastPurchasePrice: 30 }), 99)
    expect(r).toEqual({ price: 99, priceSource: "rpc" })
  })

  it("ignores a zero/negative rpcFmv and falls to pack_wap", () => {
    expect(bestPrice(node({ averageSalePrice: 12 }), 0).priceSource).toBe("pack_wap")
    expect(bestPrice(node({ averageSalePrice: 12 }), -5).price).toBe(12)
  })

  it("uses the marketplace average when the pack has no WAP", () => {
    const r = bestPrice(node({ edition: { marketplaceInfo: { averageSaleData: { averagePrice: "8.5" } } } }))
    expect(r).toEqual({ price: 8.5, priceSource: "market_wap" })
  })

  it("discounts the low ask by 5%", () => {
    const r = bestPrice(node({ lowAsk: 100 }))
    expect(r.priceSource).toBe("ask")
    expect(r.price).toBeCloseTo(95, 5)
  })

  it("discounts the last purchase price by 20% as the stalest signal", () => {
    const r = bestPrice(node({ lastPurchasePrice: 200 }))
    expect(r.priceSource).toBe("last_sale")
    expect(r.price).toBeCloseTo(160, 5)
  })

  it("returns 0/none when no signal is positive", () => {
    expect(bestPrice(node())).toEqual({ price: 0, priceSource: "none" })
  })

  it("honors the ladder order: pack_wap beats market_wap beats ask", () => {
    const r = bestPrice(
      node({
        averageSalePrice: 20,
        lowAsk: 100,
        edition: { marketplaceInfo: { averageSaleData: { averagePrice: "999" } } },
      }),
    )
    expect(r).toEqual({ price: 20, priceSource: "pack_wap" })
  })
})

describe("serialPremiumLabel — special-serial badge", () => {
  const base = { edition: { play: { stats: { jerseyNumber: 23 } } } }

  it("returns null when no premium flag is set", () => {
    expect(serialPremiumLabel({ ...base })).toBeNull()
  })

  it("labels a #1 serial", () => {
    expect(serialPremiumLabel({ ...base, serialOne: true })).toBe("#1 Serial")
  })

  it("labels a last mint", () => {
    expect(serialPremiumLabel({ ...base, lastMint: true })).toBe("Last Mint")
  })

  it("labels a jersey match using the edition's jersey number", () => {
    expect(serialPremiumLabel({ ...base, jerseyNumber: true })).toBe("Jersey #23 Match")
  })

  it("joins multiple premiums in ladder order with ' + '", () => {
    expect(serialPremiumLabel({ ...base, serialOne: true, lastMint: true, jerseyNumber: true })).toBe(
      "#1 Serial + Last Mint + Jersey #23 Match",
    )
  })
})
