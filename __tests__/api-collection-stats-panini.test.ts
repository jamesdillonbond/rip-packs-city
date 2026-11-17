import { describe, it, expect, beforeEach, vi } from "vitest"

// GET /api/collection-stats?collection=panini-blockchain (published 2026-09-25).
// get_collection_stats' generic arm reads sales + listings from the FLOW feeds,
// which hold zero Panini rows — so it returns volume 0 / no top sales for a
// market with ~17k live asks. The route must turn those into "not tracked"
// (null + sales_tracked:false), never serve them as a market fact, and attach
// the listing-gated coverage.
//
// 2026-10-14: the two LIST fields are no longer nulled — they read Panini's own
// sources (lib/panini/overview-feeds.ts): the Sniper tab's hourly deal snapshot
// and v_panini_top_sales. A failed read nulls the list AND flags `*_failed`. The
// 24h KPI fields stay null (Panini sales land ~2 days late).

const NOW_ISO = new Date().toISOString()
const DEAL = { sku: "packcard-2332_486954_12677915_367__2_7", player_name: "Cristiano Ronaldo", tier: "LEGENDARY", parallel: "Base Prizms Old Glory", serial_number: 2, ask_usd: 1250, fmv_usd: 1800, discount_pct: 31 }
const SALE = { player_name: "Luka Doncic", set_name: "Green Ice", tier: "LEGENDARY", serial_number: 2, circulation_count: 2, price_usd: 888.77, sold_at: NOW_ISO }
const state: { cov: any; deals: any; sales: any } = { cov: null, deals: null, sales: null }
// A chainable PostgREST stand-in: every builder method returns itself, and
// awaiting it yields the canned result for the table it was opened on.
const builder = (table: string): any => {
  const result = () => (table === "panini_coverage_summary" ? state.cov : table === "public_board_snapshots" ? state.deals : state.sales)
  const b: any = {}
  for (const m of ["select", "eq", "gte", "order", "limit"]) b[m] = () => b
  b.then = (res: any, rej: any) => Promise.resolve(result()).then(res, rej)
  return b
}
const STATS = {
  slug: "panini_blockchain", edition_count: 5094, fmv_pct: 100, fmv_high_medium_pct: 37.2,
  fmv_age_minutes: 0.2, volume_24h: 0, volume_7d: 0, sales_24h: 0, top_sales: [], sniper_deals: [], listing_count: 0,
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => ({ data: { ...STATS }, error: null }),
    from: (t: string) => builder(t),
  },
}))

import { GET } from "@/app/api/collection-stats/route"
const req = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => {
  state.cov = { data: [{ total_editions: 5094, edition_age_p50_h: 22.5, edition_age_p90_h: 38.9, listing_gated_editions: 3300 }], error: null }
  state.deals = { data: [{ refreshed_at: NOW_ISO, d0: DEAL, d1: null, d2: null, d3: null, d4: null }], error: null }
  state.sales = { data: [SALE], error: null }
})

describe("GET /api/collection-stats — Panini", () => {
  it("nulls the Flow-feed 24h zeros — a Panini 24h total would be a fabricated low", async () => {
    const body = await (await GET(req("https://t/api/collection-stats?collection=panini-blockchain"))).json()
    for (const k of ["volume_24h", "volume_7d", "sales_24h", "listing_count"]) {
      expect(body[k], k).toBeNull()
    }
    // The measured figures survive untouched.
    expect(body.edition_count).toBe(5094)
    expect(body.fmv_high_medium_pct).toBe(37.2)
  })

  it("the list panels carry Panini's OWN deals and sales — not the Flow arm's empty arrays", async () => {
    const body = await (await GET(req("https://t/api/collection-stats?collection=panini-blockchain"))).json()
    expect(body.sniper_deals).toHaveLength(1)
    expect(body.sniper_deals[0]).toMatchObject({
      player_name: "Cristiano Ronaldo", ask_price: 1250, discount: 31, set_name: "Base Prizms Old Glory",
      flow_id: "packcard-2332_486954_12677915_367",
      buy_url: "https://nft.paniniamerica.net/marketplace-details/packcard-2332_486954_12677915_367.html",
    })
    expect(body.sniper_deals_failed).toBe(false)
    expect(body.top_sales).toEqual([expect.objectContaining({ player_name: "Luka Doncic", price: 888.77 })])
    expect(body.top_sales_failed).toBe(false)
    expect(body.top_sales_scope).toEqual({ days: 7, min_usd: 100 })
    expect(body.sales_tracked).toBe(true)
  })

  it("a failed deals read, or a snapshot too old to call current, is NULL + flagged — never []", async () => {
    state.deals = { data: null, error: { message: "boom" } }
    let body = await (await GET(req("https://t/api/collection-stats?collection=panini-blockchain"))).json()
    expect(body.sniper_deals).toBeNull()
    expect(body.sniper_deals_failed).toBe(true)
    state.deals = { data: [{ refreshed_at: new Date(Date.now() - 3 * 3600_000).toISOString(), d0: DEAL }], error: null }
    body = await (await GET(req("https://t/api/collection-stats?collection=panini-blockchain"))).json()
    expect(body.sniper_deals).toBeNull()
    expect(body.sniper_deals_failed).toBe(true)
  })

  it("a failed sales read is NULL + flagged; an empty one is an honest []", async () => {
    state.sales = { data: null, error: { message: "boom" } }
    let body = await (await GET(req("https://t/api/collection-stats?collection=panini-blockchain"))).json()
    expect(body.top_sales).toBeNull()
    expect(body.top_sales_failed).toBe(true)
    state.sales = { data: [], error: null }
    body = await (await GET(req("https://t/api/collection-stats?collection=panini-blockchain"))).json()
    expect(body.top_sales).toEqual([])
    expect(body.top_sales_failed).toBe(false)
  })

  it("attaches the coverage figures", async () => {
    const body = await (await GET(req("https://t/api/collection-stats?collection=panini-blockchain"))).json()
    expect(body.coverage.total_editions).toBe(5094)
    expect(body.coverage.edition_age_p50_h).toBe(22.5)
    expect(body.coverage_failed).toBe(false)
  })

  it("a failed coverage read is flagged, never a zero", async () => {
    state.cov = { data: null, error: { message: "boom" } }
    const res = await GET(req("https://t/api/collection-stats?collection=panini-blockchain"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.coverage).toBeNull()
    expect(body.coverage_failed).toBe(true)
  })

  it("no-change control: another collection keeps its sales figures and gets no coverage", async () => {
    const body = await (await GET(req("https://t/api/collection-stats?collection=nba-top-shot"))).json()
    expect(body.volume_24h).toBe(0)
    expect(body).not.toHaveProperty("sales_tracked")
    expect(body).not.toHaveProperty("coverage")
  })
})
