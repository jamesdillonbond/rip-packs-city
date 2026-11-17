// @vitest-environment node
import { describe, it, expect, vi } from "vitest"
import { fetchMarketTileStats, type PulseRow } from "@/lib/market/hub"

// lib/market/hub.ts — the /market hub's tile stats (2026-09-28). Pinned:
//   * a ZERO is never published bare: it carries the last recorded sale, because
//     "0 in 24 h" is identical for a quiet market and a stalled feed (Golazos
//     read 0 while its last sale was 16 days old the day this shipped);
//   * a collection ABSENT from the pulse, or a failed pulse, has no stats —
//     never zeros;
//   * Pinnacle's zero is not dated from `sales` (its pulse reads pinnacle_sales).

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

const pulseRow = (slug: string, sales: number, volume = sales * 10, top: number | null = sales ? 99 : null): PulseRow => ({
  slug,
  sales_24h: sales,
  volume_24h: volume,
  top_sale_24h: top,
})

describe("fetchMarketTileStats", () => {
  it("passes a positive count through with its volume", async () => {
    const r = await fetchMarketTileStats(["nba-top-shot"], {
      pulse: async () => ({ ok: true, rows: [pulseRow("nba_top_shot", 2892, 15214.38, 3666)] }),
    })
    expect(r.pulseOk).toBe(true)
    expect(r.stats.get("nba-top-shot")).toEqual({ sales24h: 2892, volume24h: 15214.38, topSale24h: 3666 })
  })

  it("⛔ a zero carries its last recorded sale — never a bare zero", async () => {
    const lastSale = vi.fn(async () => "2026-09-12T22:24:33Z")
    const r = await fetchMarketTileStats(["laliga-golazos"], {
      pulse: async () => ({ ok: true, rows: [pulseRow("laliga_golazos", 0, 0)] }),
      lastSale,
    })
    expect(lastSale).toHaveBeenCalledTimes(1)
    expect(r.stats.get("laliga-golazos")).toEqual({ sales24h: 0, volume24h: null, topSale24h: null, lastSaleAt: "2026-09-12T22:24:33Z" })
  })

  it("drops a zero whose last-sale read FAILED rather than publish it undated", async () => {
    const r = await fetchMarketTileStats(["laliga-golazos"], {
      pulse: async () => ({ ok: true, rows: [pulseRow("laliga_golazos", 0, 0)] }),
      lastSale: async () => undefined,
    })
    expect(r.stats.has("laliga-golazos")).toBe(false)
  })

  it("⛔ never dates Pinnacle's zero from `sales` — its pulse reads pinnacle_sales", async () => {
    const lastSale = vi.fn(async () => null)
    const r = await fetchMarketTileStats(["disney-pinnacle"], {
      pulse: async () => ({ ok: true, rows: [pulseRow("disney_pinnacle", 0, 0)] }),
      lastSale,
    })
    expect(lastSale).not.toHaveBeenCalled()
    expect(r.stats.has("disney-pinnacle")).toBe(false)
  })

  it("a collection ABSENT from the pulse has no stats — never zero-filled", async () => {
    const r = await fetchMarketTileStats(["panini-blockchain", "nba-top-shot"], {
      pulse: async () => ({ ok: true, rows: [pulseRow("nba_top_shot", 5)] }),
    })
    expect(r.stats.has("panini-blockchain")).toBe(false)
    expect(r.stats.has("nba-top-shot")).toBe(true)
  })

  it("a FAILED pulse is pulseOk:false with no stats at all", async () => {
    const r = await fetchMarketTileStats(["nba-top-shot"], { pulse: async () => ({ ok: false }) })
    expect(r).toEqual({ pulseOk: false, stats: new Map() })
  })
})

