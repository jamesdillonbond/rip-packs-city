import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/cross-collection-deals. No auth gate.
// Mocks @/lib/supabase's supabaseAdmin.rpc("get_cross_collection_deals").
// Pins the happy path (200 pass-through of RPC data) and the RPC-error → 500.

const state: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: state.data, error: state.error }) },
}))

import { GET } from "@/app/api/cross-collection-deals/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.data = null
  state.error = null
})

describe("GET /api/cross-collection-deals", () => {
  it("returns the RPC payload on success", async () => {
    state.data = { deals: [{ id: "d1" }], per_collection: { nba_top_shot: 1 } }
    const res = await GET(req("https://t/api/cross-collection-deals?limit=10&minDiscount=15"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.deals).toHaveLength(1)
    expect(body.per_collection).toEqual({ nba_top_shot: 1 })
  })

  it("falls back to an empty shape when the RPC returns null", async () => {
    state.data = null
    state.error = null
    const res = await GET(req("https://t/api/cross-collection-deals"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deals: [], per_collection: {} })
  })

  it("500s on an RPC error", async () => {
    state.error = { message: "boom" }
    const res = await GET(req("https://t/api/cross-collection-deals"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Database query failed")
  })
})
