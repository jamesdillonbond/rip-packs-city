import { describe, it, expect } from "vitest"
import { marketplaceLabel, marketplaceColor } from "@/lib/analytics/format"

// The All Day sale-kind keys (get_allday_daily_sale_kind_volume, 2026-10-26) read as words, never "Allday_offer_fill".
describe("All Day sale-kind labels", () => {
  it("label and colour each key", () => {
    expect(marketplaceLabel("allday_listing")).toBe("Listings")
    expect(marketplaceLabel("allday_offer_fill")).toBe("Accepted offers")
    expect(marketplaceLabel("allday_buyback")).toBe("Pack buybacks")
    for (const k of ["allday_listing", "allday_offer_fill", "allday_buyback"]) expect(marketplaceColor(k)).not.toBe("#6B7280")
  })
})
