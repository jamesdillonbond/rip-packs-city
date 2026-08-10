import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/support-chat/search-deals. Internal
// (no-auth) endpoint that wraps the get_top_deals RPC. Empty data → { deals: [] }.
//
// This file used to assert that an RPC error "is swallowed to a 200
// { deals: [], error }". That contract was retired 2026-08-09 (deep-audit D11
// class): the swallowed shape was identical to a genuine empty result, so a
// caller reading `deals` reported "no deals found" for a database outage, and
// the body published Postgres's own message. Mocks @supabase/supabase-js
// createClient.

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

  // The load-bearing property: a failure must be distinguishable from an empty
  // result. `deals` is absent entirely, so a caller cannot read it as "none".
  it("fails with a real status on an RPC error, and never returns an empty deals list", async () => {
    state.error = { message: "boom" }
    const res = await POST(req({}))
    expect(res.status).not.toBe(200)
    const body = await res.json()
    expect(body.deals).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain("boom")
  })

  it("503s + Retry-After on a statement timeout", async () => {
    state.error = { code: "57014", message: "canceling statement due to statement timeout" }
    const res = await POST(req({}))
    expect(res.status).toBe(503)
    expect(res.headers.get("Retry-After")).toBe("30")
    const body = await res.json()
    expect(body.code).toBe("timeout")
    expect(body.deals).toBeUndefined()
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
