// lib/panini/overview-feeds.ts — the parsers behind the Panini overview's list
// panels (2026-10-14). The route test drives the reads; this pins the row shapes.
import { describe, it, expect } from "vitest"
import { editionKeyOfSku, parsePaniniDeal, parsePaniniSale } from "@/lib/panini/overview-feeds"

describe("editionKeyOfSku", () => {
  it("strips the __<serial>_<cap> suffix, and refuses a sku without one", () => {
    expect(editionKeyOfSku("packcard-2332_486954_12677915_367__2_7")).toBe("packcard-2332_486954_12677915_367")
    expect(editionKeyOfSku("packcard-2332_486954_12677915_367")).toBeNull()
    expect(editionKeyOfSku(null)).toBeNull()
  })
})

describe("parsePaniniDeal", () => {
  it("maps a deals_all row to the overview's deal shape, linking the card's Panini page", () => {
    const d = parsePaniniDeal({ sku: "packcard-1_2_3_4__5_10", player_name: "A", tier: "RARE", parallel: "Gold", serial_number: 5, ask_usd: "12.5", fmv_usd: 20, discount_pct: 37 })
    expect(d).toEqual({
      flow_id: "packcard-1_2_3_4", player_name: "A", tier: "RARE", set_name: "Gold", serial_number: 5,
      ask_price: 12.5, fmv: 20, discount: 37,
      buy_url: "https://nft.paniniamerica.net/marketplace-details/packcard-1_2_3_4.html",
    })
  })

  it("drops a row with no usable ask rather than rendering a $0 deal", () => {
    expect(parsePaniniDeal({ sku: "packcard-1_2_3_4__5_10", ask_usd: 0 })).toBeNull()
    expect(parsePaniniDeal({ sku: "packcard-1_2_3_4__5_10", ask_usd: null })).toBeNull()
    expect(parsePaniniDeal(null)).toBeNull()
  })
})

describe("parsePaniniSale", () => {
  it("maps a v_panini_top_sales row, and drops one with no price or time", () => {
    expect(parsePaniniSale({ player_name: "B", set_name: "Silver", tier: null, serial_number: 1, circulation_count: 1, price_usd: "250", sold_at: "2026-10-14T00:00:00Z" }))
      .toEqual({ edition_name: null, player_name: "B", tier: null, set_name: "Silver", serial_number: 1, circulation_count: 1, price: 250, sold_at: "2026-10-14T00:00:00Z" })
    expect(parsePaniniSale({ price_usd: 250 })).toBeNull()
    expect(parsePaniniSale({ price_usd: 0, sold_at: "2026-10-14T00:00:00Z" })).toBeNull()
  })
})
