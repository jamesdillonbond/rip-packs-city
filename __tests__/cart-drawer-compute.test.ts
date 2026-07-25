import { describe, it, expect } from "vitest"
import type { CartItem, PurchaseStatus } from "@/lib/cart/CartContext"
import {
  formatPrice,
  fmvDeltaLabel,
  isDapperOnly,
  isFlowCompatible,
  cartTierColor,
  CART_TIER_COLORS,
  countStatuses,
  splitPending,
  selectFlowCompatible,
  computeCartTotals,
  checkInsufficientBalance,
} from "@/lib/cart-drawer-compute"

// Pins the pure pricing / compatibility / totals logic lifted out of
// components/cart/CartDrawer.tsx (invisible to the coverage ratchet). A
// regression here mis-prices the cart, mis-splits buy/offer lanes, or wrongly
// clears/raises the insufficient-balance guard.

// Minimal CartItem factory — only the fields the pure helpers read matter.
function item(partial: Partial<CartItem>): CartItem {
  return {
    listingResourceID: "L1",
    storefrontAddress: "0xseller",
    expectedPrice: 10,
    commissionRecipient: null,
    momentId: 1,
    playerName: "Player",
    setName: "Set",
    serialNumber: 1,
    totalEditions: 100,
    tier: "COMMON",
    thumbnailUrl: null,
    fmv: null,
    source: "sniper",
    paymentToken: "FLOW",
    cartMode: "buy",
    addedAt: 0,
    ...partial,
  }
}

describe("formatPrice", () => {
  it("formats to 2 decimals with a dollar sign", () => {
    expect(formatPrice(0)).toBe("$0.00")
    expect(formatPrice(12.5)).toBe("$12.50")
    expect(formatPrice(3.146)).toBe("$3.15")
  })
})

describe("fmvDeltaLabel", () => {
  it("returns null when fmv is missing or zero", () => {
    expect(fmvDeltaLabel(10, null)).toBeNull()
    expect(fmvDeltaLabel(10, undefined)).toBeNull()
    expect(fmvDeltaLabel(10, 0)).toBeNull()
  })
  it("labels a below-FMV price as a discount", () => {
    expect(fmvDeltaLabel(80, 100)).toEqual({ label: "20% below FMV", isDiscount: true })
  })
  it("labels an above-FMV price as a premium", () => {
    expect(fmvDeltaLabel(150, 100)).toEqual({ label: "50% above FMV", isDiscount: false })
  })
  it("treats an exactly-at-FMV price as a (0%) premium, not a discount", () => {
    expect(fmvDeltaLabel(100, 100)).toEqual({ label: "0% above FMV", isDiscount: false })
  })
  it("rounds the percentage to a whole number", () => {
    expect(fmvDeltaLabel(66, 100)).toEqual({ label: "34% below FMV", isDiscount: true })
  })
})

describe("isDapperOnly / isFlowCompatible", () => {
  it("DUC and FUT are Dapper-only", () => {
    expect(isDapperOnly(item({ paymentToken: "DUC" }))).toBe(true)
    expect(isDapperOnly(item({ paymentToken: "FUT" }))).toBe(true)
    expect(isDapperOnly(item({ paymentToken: "FLOW" }))).toBe(false)
    expect(isDapperOnly(item({ paymentToken: "USDC_E" }))).toBe(false)
  })
  it("FLOW and USDC_E are Flow-compatible", () => {
    expect(isFlowCompatible(item({ paymentToken: "FLOW" }))).toBe(true)
    expect(isFlowCompatible(item({ paymentToken: "USDC_E" }))).toBe(true)
    expect(isFlowCompatible(item({ paymentToken: "DUC" }))).toBe(false)
    expect(isFlowCompatible(item({ paymentToken: "FUT" }))).toBe(false)
  })
})

describe("cartTierColor", () => {
  it("maps known tiers (case-insensitive)", () => {
    expect(cartTierColor("ULTIMATE")).toBe(CART_TIER_COLORS.ULTIMATE)
    expect(cartTierColor("legendary")).toBe("text-orange-400")
    expect(cartTierColor("Rare")).toBe("text-purple-400")
  })
  it("falls back to slate for unknown/null/undefined", () => {
    expect(cartTierColor("MYTHIC")).toBe("text-slate-400")
    expect(cartTierColor(null)).toBe("text-slate-400")
    expect(cartTierColor(undefined)).toBe("text-slate-400")
  })
})

describe("countStatuses", () => {
  it("counts success, unavailable, and folds sniped/price_changed into failed", () => {
    const map: Record<string, PurchaseStatus> = {
      a: "success",
      b: "success",
      c: "failed",
      d: "sniped",
      e: "price_changed",
      f: "unavailable",
      g: "idle",
      h: "pending",
    }
    expect(countStatuses(map)).toEqual({ successCount: 2, failedCount: 3, unavailableCount: 1 })
  })
  it("returns zeros for an empty map", () => {
    expect(countStatuses({})).toEqual({ successCount: 0, failedCount: 0, unavailableCount: 0 })
  })
})

describe("splitPending", () => {
  const items = [
    item({ listingResourceID: "buy-idle", cartMode: "buy" }),
    item({ listingResourceID: "buy-untouched", cartMode: "buy" }),
    item({ listingResourceID: "offer-idle", cartMode: "offer" }),
    item({ listingResourceID: "buy-done", cartMode: "buy" }),
    item({ listingResourceID: "offer-pending", cartMode: "offer" }),
  ]
  const status: Record<string, PurchaseStatus> = {
    "buy-idle": "idle",
    "buy-done": "success",
    "offer-pending": "pending",
    // "buy-untouched" and "offer-idle" have no entry → still pending
  }

  it("treats items with no status or 'idle' as pending and splits by cartMode", () => {
    const { pendingBuyItems, pendingOfferItems } = splitPending(items, status)
    expect(pendingBuyItems.map((i) => i.listingResourceID)).toEqual(["buy-idle", "buy-untouched"])
    expect(pendingOfferItems.map((i) => i.listingResourceID)).toEqual(["offer-idle"])
  })
})

describe("selectFlowCompatible", () => {
  const buy = [
    item({ listingResourceID: "flow", paymentToken: "FLOW" }),
    item({ listingResourceID: "usdc", paymentToken: "USDC_E" }),
    item({ listingResourceID: "duc", paymentToken: "DUC" }),
    item({ listingResourceID: "fut", paymentToken: "FUT" }),
  ]
  it("on a Dapper/unknown wallet, every buy item is eligible and none skipped", () => {
    const { flowCompatibleItems, skippedCount } = selectFlowCompatible(buy, false)
    expect(flowCompatibleItems).toBe(buy)
    expect(skippedCount).toBe(0)
  })
  it("on a Flow wallet, only Flow-compatible items are eligible; Dapper-only are skipped", () => {
    const { flowCompatibleItems, skippedCount } = selectFlowCompatible(buy, true)
    expect(flowCompatibleItems.map((i) => i.listingResourceID)).toEqual(["flow", "usdc"])
    expect(skippedCount).toBe(2)
  })
})

describe("computeCartTotals", () => {
  it("Flow wallet: totals split per token; offer lane in USDC.e", () => {
    const pendingBuy = [
      item({ paymentToken: "FLOW", expectedPrice: 10 }),
      item({ paymentToken: "USDC_E", expectedPrice: 20 }),
      item({ paymentToken: "DUC", expectedPrice: 30 }),
    ]
    const flowCompatible = [pendingBuy[0], pendingBuy[1]]
    const pendingOffer = [item({ cartMode: "offer", offerAmount: 5 }), item({ cartMode: "offer" })]
    const t = computeCartTotals(pendingBuy, flowCompatible, pendingOffer, true)
    expect(t.pendingBuyTotal).toBe(60)
    expect(t.buyableTotal).toBe(30)
    expect(t.flowItemsTotal).toBe(10)
    expect(t.usdcBuyTotal).toBe(20)
    expect(t.offerTotal).toBe(5) // second offer has no amount → 0
    expect(t.totalUsdcNeeded).toBe(25)
    expect(t.hasFlowItems).toBe(true)
    expect(t.hasUsdcItems).toBe(true)
  })

  it("Dapper wallet: per-token totals are 0 (not gated on), buyable = all pending buys", () => {
    const pendingBuy = [
      item({ paymentToken: "FLOW", expectedPrice: 10 }),
      item({ paymentToken: "DUC", expectedPrice: 30 }),
    ]
    // On a Dapper wallet the component passes flowCompatibleItems === pendingBuyItems.
    const t = computeCartTotals(pendingBuy, pendingBuy, [], false)
    expect(t.pendingBuyTotal).toBe(40)
    expect(t.buyableTotal).toBe(40)
    expect(t.flowItemsTotal).toBe(0)
    expect(t.usdcBuyTotal).toBe(0)
    expect(t.offerTotal).toBe(0)
    expect(t.totalUsdcNeeded).toBe(0)
    expect(t.hasFlowItems).toBe(false)
    expect(t.hasUsdcItems).toBe(false)
  })

  it("hasUsdcItems is true when only offers exist", () => {
    const offers = [item({ cartMode: "offer", offerAmount: 7 })]
    const t = computeCartTotals([], [], offers, true)
    expect(t.hasFlowItems).toBe(false)
    expect(t.hasUsdcItems).toBe(true)
    expect(t.totalUsdcNeeded).toBe(7)
  })
})

describe("checkInsufficientBalance", () => {
  it("flags insufficient FLOW only when there are flow items over balance", () => {
    expect(
      checkInsufficientBalance({
        hasFlowItems: true,
        hasUsdcItems: false,
        flowItemsTotal: 50,
        totalUsdcNeeded: 0,
        flowBalance: 40,
        usdcBalance: 0,
      }),
    ).toEqual({ insufficientFlow: true, insufficientUsdc: false })
  })
  it("flags insufficient USDC only when usdc needed exceeds balance", () => {
    expect(
      checkInsufficientBalance({
        hasFlowItems: false,
        hasUsdcItems: true,
        flowItemsTotal: 0,
        totalUsdcNeeded: 30,
        flowBalance: 0,
        usdcBalance: 25,
      }),
    ).toEqual({ insufficientFlow: false, insufficientUsdc: true })
  })
  it("never flags when balances cover the spend", () => {
    expect(
      checkInsufficientBalance({
        hasFlowItems: true,
        hasUsdcItems: true,
        flowItemsTotal: 10,
        totalUsdcNeeded: 10,
        flowBalance: 100,
        usdcBalance: 100,
      }),
    ).toEqual({ insufficientFlow: false, insufficientUsdc: false })
  })
  it("never flags a token type that has no items even if balance is 0", () => {
    expect(
      checkInsufficientBalance({
        hasFlowItems: false,
        hasUsdcItems: false,
        flowItemsTotal: 5,
        totalUsdcNeeded: 5,
        flowBalance: 0,
        usdcBalance: 0,
      }),
    ).toEqual({ insufficientFlow: false, insufficientUsdc: false })
  })
})
