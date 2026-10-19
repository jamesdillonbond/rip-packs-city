import { describe, it, expect } from "vitest"
import { fetchIndexCatalogDeals } from "@/lib/concierge/catalog-deals-index"
import { marketplaceMomentUrl } from "@/lib/collections"

// 2026-10-18: get_allday_market_editions_v3 returns no floor_flow_id, so every All
// Day deal from the concierge's catalog-deals index carried buy_url: null. The
// listing now comes from allday_edition_floor_ask, linked ONLY when its ask is the
// ask the row quotes.

type Floor = { edition_id: string; floor_ask: number; floor_flow_id: string | null }

function fakeDb(opts: { rows: Array<Record<string, unknown>>; floors?: Floor[]; floorError?: boolean; golazosRows?: Array<Record<string, unknown>> }) {
  const fromCalls: string[] = []
  return {
    fromCalls,
    rpc: async (name: string) => {
      if (name === "get_allday_market_editions_v3") return { data: opts.rows, error: null }
      if (name === "get_golazos_catalog_deals") return { data: opts.golazosRows ?? [], error: null }
      return { data: null, error: { message: "unexpected rpc " + name } }
    },
    from: (view: string) => {
      fromCalls.push(view)
      return {
        select: () => ({
          in: async () => (opts.floorError ? { data: null, error: { message: "timeout" } } : { data: opts.floors ?? [], error: null }),
        }),
      }
    },
  }
}

const row = (id: string, ask: number) => ({
  edition_id: id, external_id: `ext-${id}`, player_name: "Patrick Mahomes", set_name: "Base", tier: "COMMON",
  floor_ask: ask, fmv_usd: ask * 2, discount_pct: 50, confidence: "HIGH", badges: null,
})

describe("concierge catalog deals — All Day rows carry a buy link to the floor listing", () => {
  it("links the floor listing when its ask is the ask the row quotes", async () => {
    const db = fakeDb({ rows: [row("e1", 10)], floors: [{ edition_id: "e1", floor_ask: 10, floor_flow_id: "777" }] })
    const r = await fetchIndexCatalogDeals(db as never, "nfl-all-day", {}, "https://x")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(db.fromCalls).toEqual(["allday_edition_floor_ask"])
    expect(r.results[0].buy_url).toBe(marketplaceMomentUrl("nfl-all-day", "777"))
    expect(r.results[0].buy_url).toContain("777")
  })

  it("does NOT link a listing whose ask differs from the quoted one (a different listing)", async () => {
    const db = fakeDb({ rows: [row("e1", 10)], floors: [{ edition_id: "e1", floor_ask: 12, floor_flow_id: "778" }] })
    const r = await fetchIndexCatalogDeals(db as never, "nfl-all-day", {}, "https://x")
    if (!r.ok) throw new Error("read failed")
    expect(r.results[0].buy_url).toBeNull()
    expect(r.results[0].price).toBe(10)
  })

  it("a FAILED floor lookup costs the link, never the row", async () => {
    const db = fakeDb({ rows: [row("e1", 10)], floorError: true })
    const r = await fetchIndexCatalogDeals(db as never, "nfl-all-day", {}, "https://x")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.results).toHaveLength(1)
    expect(r.results[0].buy_url).toBeNull()
    expect(r.results[0].edition_url).toContain("ext-e1")
  })

  it("CONTROL: Golazos keeps its RPC's own floor_flow_id and reads no floor view", async () => {
    const db = fakeDb({ rows: [], golazosRows: [{ ...row("g1", 5), floor_flow_id: "555" }] })
    const r = await fetchIndexCatalogDeals(db as never, "laliga-golazos", {}, "https://x")
    if (!r.ok) throw new Error("read failed")
    expect(db.fromCalls).toEqual([])
    expect(r.results[0].buy_url).toBe(marketplaceMomentUrl("laliga-golazos", "555"))
  })
})
