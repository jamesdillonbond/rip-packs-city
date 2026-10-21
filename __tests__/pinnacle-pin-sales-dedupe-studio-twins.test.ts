// 2026-10-20 live sweep: /pinnacle/moment/LEV1-EP4S-REBE-S6 listed each of three sales
// twice — a pinnacle_studio_history_v1 row (buyer without 0x, no seller) and the on-chain
// row of the same NFT, price and buyer, dated days apart.
import { describe, it, expect } from "vitest"
import { dedupeStudioTwinSales, type SaleRow } from "@/lib/pinnacle/moment-detail"

const row = (p: Partial<SaleRow>): SaleRow => ({ sale_price_usd: 29, sold_at: null, serial_number: 62, buyer_address: null, seller_address: null, ...p })

describe("dedupeStudioTwinSales", () => {
  it("drops the studio twin of an on-chain sale (same NFT, price, buyer; 0x-insensitive)", () => {
    const out = dedupeStudioTwinSales([
      row({ source: "pinnacle_studio_history_v1", nft_id: "90159954397461", buyer_address: "6210ceaa820b81d5", sold_at: "2026-02-26" }),
      row({ source: "on-chain", nft_id: "90159954397461", buyer_address: "0x6210CEAA820b81d5", seller_address: "0xad89", sold_at: "2026-03-06" }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].source).toBe("on-chain")
  })

  it("keeps a studio row with no on-chain twin, and a different buyer or price", () => {
    const out = dedupeStudioTwinSales([
      row({ source: "pinnacle_studio_history_v1", nft_id: "1", buyer_address: "aa" }),
      row({ source: "pinnacle_studio_history_v1", nft_id: "2", buyer_address: "bb", sale_price_usd: 30 }),
      row({ source: "on-chain", nft_id: "2", buyer_address: "0xbb", sale_price_usd: 31 }),
      row({ source: "pinnacle_studio_history_v1", nft_id: "3", buyer_address: "cc" }),
      row({ source: "on-chain", nft_id: "3", buyer_address: "0xdd" }),
    ])
    expect(out).toHaveLength(5)
  })

  it("never drops an on-chain row, even if two look alike", () => {
    const out = dedupeStudioTwinSales([
      row({ source: "on-chain", nft_id: "4", buyer_address: "0xee" }),
      row({ source: "on-chain-history-backfill", nft_id: "4", buyer_address: "0xee" }),
    ])
    expect(out).toHaveLength(2)
  })
})
