import { describe, it, expect, beforeEach, vi } from "vitest"

// GET /api/collection-stats?collection=panini-blockchain (published 2026-09-25).
// get_collection_stats' generic arm reads sales + listings from the FLOW feeds,
// which hold zero Panini rows — so it returns volume 0 / no top sales for a
// market with ~17k live asks. The route must turn those into "not tracked"
// (null + sales_tracked:false), never serve them as a market fact, and attach
// the listing-gated coverage.

const state: { cov: any } = { cov: null }
const STATS = {
  slug: "panini_blockchain", edition_count: 5094, fmv_pct: 100, fmv_high_medium_pct: 37.2,
  fmv_age_minutes: 0.2, volume_24h: 0, volume_7d: 0, sales_24h: 0, top_sales: [], sniper_deals: [], listing_count: 0,
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => ({ data: { ...STATS }, error: null }),
    from: () => ({
      select: () => ({ limit: async () => state.cov }),
    }),
  },
}))

import { GET } from "@/app/api/collection-stats/route"
const req = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => {
  state.cov = { data: [{ total_editions: 5094, edition_age_p50_h: 22.5, edition_age_p90_h: 38.9, listing_gated_editions: 3300 }], error: null }
})

describe("GET /api/collection-stats — Panini", () => {
  it("nulls the Flow-feed sales zeros and marks sales untracked", async () => {
    const body = await (await GET(req("https://t/api/collection-stats?collection=panini-blockchain"))).json()
    expect(body.sales_tracked).toBe(false)
    for (const k of ["volume_24h", "volume_7d", "sales_24h", "top_sales", "listing_count", "sniper_deals"]) {
      expect(body[k], k).toBeNull()
    }
    // The measured figures survive untouched.
    expect(body.edition_count).toBe(5094)
    expect(body.fmv_high_medium_pct).toBe(37.2)
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
