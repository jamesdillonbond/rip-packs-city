import { describe, it, expect } from "vitest"
import {
  cartEligibilityReason,
  isCartEligible,
  cartIneligibleTooltip,
} from "@/lib/cart/eligibility"

// Gates which listings can enter the Flow Wallet cart. Dapper-custody (topshot/
// pinnacle) and unsupported currencies must be rejected; Flowty/NFTStorefrontV2
// FLOW/DUC listings pass. Pin every branch.

const ok = {
  listingResourceID: "L1",
  storefrontAddress: "0xabc",
  expectedPrice: 10,
  source: "flowty",
}

describe("cartEligibilityReason", () => {
  it("requires listing id / storefront / positive price", () => {
    expect(cartEligibilityReason({ ...ok, listingResourceID: null })).toBe("missing_listing_id")
    expect(cartEligibilityReason({ ...ok, storefrontAddress: null })).toBe("missing_storefront")
    expect(cartEligibilityReason({ ...ok, expectedPrice: 0 })).toBe("missing_price")
  })

  it("rejects Dapper-custody sources", () => {
    expect(cartEligibilityReason({ ...ok, source: "topshot" })).toBe("dapper_only")
    expect(cartEligibilityReason({ ...ok, source: "pinnacle" })).toBe("dapper_only")
  })

  it("Flowty listings are eligible", () => {
    expect(cartEligibilityReason({ ...ok, source: "flowty" })).toBe("ok")
  })

  it("rejects unsupported currency for non-Flowty sources", () => {
    expect(
      cartEligibilityReason({ ...ok, source: "other", paymentToken: "USDC" })
    ).toBe("unsupported_currency")
  })

  it("accepts FLOW/DUC on the default NFTStorefrontV2", () => {
    expect(cartEligibilityReason({ ...ok, source: "other", paymentToken: "FLOW" })).toBe("ok")
    expect(cartEligibilityReason({ ...ok, source: "other", paymentToken: "DUC" })).toBe("ok")
  })
})

describe("isCartEligible", () => {
  it("is true only when the reason is 'ok'", () => {
    expect(isCartEligible(ok)).toBe(true)
    expect(isCartEligible({ ...ok, source: "topshot" })).toBe(false)
  })
})

describe("cartIneligibleTooltip", () => {
  it("returns a human message per reason, empty for ok", () => {
    expect(cartIneligibleTooltip("ok")).toBe("")
    expect(cartIneligibleTooltip("dapper_only")).toContain("Dapper purchase only")
    expect(cartIneligibleTooltip("unsupported_currency")).toContain("Currency not supported")
    expect(cartIneligibleTooltip("missing_price")).toContain("missing on-chain data")
  })
})
