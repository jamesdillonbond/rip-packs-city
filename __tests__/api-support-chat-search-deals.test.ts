import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/support-chat/search-deals. Internal
// (no-auth) endpoint that wraps the get_top_deals RPC. Empty data → { deals: [] };
// an RPC error is swallowed to a 200 { deals: [], error }. Mocks
// @supabase/supabase-js createClient.

const state: { data: any; error: any } = { data: [], error: null }

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: async () => ({ data: state.data, error: state.error }) }),
}))

import { POST } from "@/app/api/support-chat/search-deals/route"

const req = (body: any) => ({ json: async () => body }) as any

beforeEach(() => { state.data = []; state.error = null })

describe("POST /api/support-chat/search-deals", () => {
  it("returns an empty deals list when the RPC yields no rows", async () => {
    const res = await POST(req({ player: "Curry" }))
    expect(res.status).toBe(200)
    expect((await res.json()).deals).toEqual([])
  })

  it("swallows an RPC error to a 200 with an empty deals list", async () => {
    state.error = { message: "boom" }
    const res = await POST(req({}))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.deals).toEqual([])
    expect(body.error).toBe("boom")
  })

  it("maps rows to deals with computed discount + meta", async () => {
    state.data = [
      { player_name: "Curry", tier: "MOMENT_TIER_RARE", set_name: "Base", series_number: 8, low_ask: "50", fmv_usd: "100", discount_pct: 50, external_id: "1:2" },
    ]
    const res = await POST(req({}))
    const body = await res.json()
    expect(body.deals).toHaveLength(1)
    expect(body.deals[0].discount_pct).toBe(50)
    expect(body.meta.total).toBe(1)
  })
})
