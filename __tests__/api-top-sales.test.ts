import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/top-sales. Multi-collection recent-top-sales
// feed via get_top_sales. An unknown collection returns { sales: [] } (200, not a
// 400); a valid collection maps RPC rows to the normalized shape; an RPC error →
// { sales: [] } with 500. Mocks supabaseAdmin.rpc.

const rpc: { data: any; error: any } = { data: [], error: null }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/top-sales/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => { rpc.data = []; rpc.error = null })

describe("GET /api/top-sales", () => {
  it("returns { sales: [] } for an unknown collection", async () => {
    const res = await GET(req("https://t/api/top-sales?collection=not-real"))
    expect(res.status).toBe(200)
    expect((await res.json()).sales).toEqual([])
  })

  it("maps RPC rows for a valid collection", async () => {
    rpc.data = [
      { player_name: "Curry", set_name: "Base", tier: "rare", serial_number: 7, circulation_count: 100, price_usd: 250 },
    ]
    const res = await GET(req("https://t/api/top-sales?collection=nba-top-shot&limit=5"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sales[0]).toMatchObject({ playerName: "Curry", tier: "RARE", price: 250 })
  })

  it("500s (with empty sales) on an RPC error", async () => {
    rpc.error = { message: "db" }
    const res = await GET(req("https://t/api/top-sales?collection=nba-top-shot"))
    expect(res.status).toBe(500)
    expect((await res.json()).sales).toEqual([])
  })
})
