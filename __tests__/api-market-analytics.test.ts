import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/market-analytics (GET).
// Guard: unknown ?collection (not in COLLECTION_UUID_BY_SLUG) → 400. The base
// time-series comes from the get_daily_marketplace_volume RPC. Pins the unknown-
// collection 400, a basic-detail happy path (empty daily), and the daily-RPC 500.

const state: { daily: any } = { daily: { data: [], error: null } }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string) =>
      name.includes("daily_marketplace_volume") ? state.daily : { data: [], error: null },
  },
}))

import { GET } from "@/app/api/market-analytics/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => {
  state.daily = { data: [], error: null }
})

describe("GET /api/market-analytics", () => {
  it("400s on an unknown collection", async () => {
    const res = await GET(req("https://t/api/market-analytics?collection=bogus"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Unknown collection")
  })

  it("returns a basic-detail payload with empty totals when there are no sales", async () => {
    const res = await GET(req("https://t/api/market-analytics?collection=nba-top-shot&period=30d"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.period).toBe("30d")
    expect(body.totals).toEqual({ totalSales: 0, totalVolume: 0 })
    expect(body.daily).toEqual([])
  })

  it("500s when the daily-volume RPC errors", async () => {
    state.daily = { data: null, error: { message: "agg fail" } }
    const res = await GET(req("https://t/api/market-analytics?collection=nba-top-shot"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Query failed")
  })
})
