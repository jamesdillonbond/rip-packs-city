import { describe, it, expect } from "vitest"
import { normalizePaniniPackDrops, paniniUtcToIso } from "@/lib/panini/pack-drops"

// Shapes read from Panini's store in Trevor's Chrome, 2026-11-08 (`packs` and `packsTimeline`).
const storeRolling = { pack_id: 1060, pack_name: "2026 Panini NFT Prizm The Rolling Stones Packs", sport: "ENTERTAINMENT", subpack_price: 25, cards_per_subpack: 5, start_date: "2026-11-06 16:00:00", end_date: "", in_stock: true, is_available: true, status: 1, url_key: "pack-2026_Panini_NFT_Prizm_The_Rolling_Stones_Packs", subpack_qty: 18586 }
const storeWnba = { pack_id: 1056, pack_name: "2026 Panini NFT Prizm WNBA Packs", sport: "WOMENS BASKETBALL", subpack_price: 30, cards_per_subpack: 4, start_date: "2026-09-30 15:00:00", in_stock: true, is_available: true, status: 1, subpack_qty: 228 }
const tlWnba = { ...storeWnba, subpack_qty: 999, total_subpack_qty: 23512 }
const tlStickers = { pack_id: 1058, pack_name: "2026 Panini NFT Prizm FIFA World Cup Sticker Packs", sport: "SOCCER", subpack_price: 8, cards_per_subpack: 5, start_date: "2026-10-26 15:00:00", end_date: null, in_stock: false, is_available: true, status: 2, total_subpack_qty: 160320, subpack_qty: 0 }

describe("paniniUtcToIso", () => {
  it("reads Panini's UTC wall time (16:00 UTC = 8 AM PST on Nov 6)", () => {
    expect(paniniUtcToIso("2026-11-06 16:00:00")).toBe("2026-11-06T16:00:00.000Z")
  })
  it("is null for anything that is not a real date", () => {
    for (const v of ["", null, undefined, "0000-00-00 00:00:00", "soon", "2123-03-06 09:00:00", 5]) expect(paniniUtcToIso(v)).toBeNull()
  })
})

describe("normalizePaniniPackDrops", () => {
  it("merges a pack seen in both lists: the store's live stock wins, the timeline fills the total", () => {
    const rows = normalizePaniniPackDrops({ store: [storeRolling, storeWnba], timeline: [tlWnba, tlStickers] })
    const byId = Object.fromEntries(rows.map((r) => [r.pack_id, r]))
    expect(Object.keys(byId).sort()).toEqual(["1056", "1058", "1060"])
    expect(byId["1056"]).toMatchObject({ remaining_qty: 228, total_qty: 23512, seen_in: ["store", "timeline"] })
    expect(byId["1060"]).toMatchObject({ start_at: "2026-11-06T16:00:00.000Z", price_usd: 25, in_stock: true, end_at: null, seen_in: ["store"] })
    expect(byId["1058"]).toMatchObject({ in_stock: false, seen_in: ["timeline"] })
  })

  it("drops what it cannot key or name, and an empty or malformed payload yields nothing", () => {
    expect(normalizePaniniPackDrops({ store: [{ pack_id: "x", pack_name: "A" }, { pack_id: 7 }, null] })).toEqual([])
    expect(normalizePaniniPackDrops(null)).toEqual([])
    expect(normalizePaniniPackDrops([storeRolling])).toEqual([])
  })
})
