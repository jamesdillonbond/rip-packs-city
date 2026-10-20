import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/support-chat/search-deals. Internal
// (server-secret) endpoint that wraps the get_top_deals RPC. Empty data → { deals: [] }.
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

// 2026-10-03: the route is server-only in fact, not only in its comment —
// every call carries the ingest token; an unauthenticated POST is 401.
process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
const req = (body: any, auth: string | null = "Bearer test-ingest-token") =>
  ({ json: async () => body, headers: new Headers(auth ? { authorization: auth } : {}) }) as any

beforeEach(() => { state.data = []; state.error = null })

describe("POST /api/support-chat/search-deals — server callers only", () => {
  it("401s without the server secret, with a wrong one, and the body carries no deals", async () => {
    state.data = [{ player_name: "x", ask_price: 1, fmv: 2 }]
    for (const auth of [null, "Bearer nope", "Basic abc"]) {
      const res = await POST(req({ limit: 1 }, auth))
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: "Unauthorized" })
    }
  })
})

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

  // 2026-10-19: a row with no ask was published as a $0 ask, and an uncomputable
  // discount as "0% off" (`parseFloat(low_ask ?? "0")`, `: 0`).
  it("drops a row with no ask and leaves an unknown discount null, never a $0 ask or 0% off", async () => {
    state.data = [
      { player_name: "NoAsk", tier: "MOMENT_TIER_RARE", set_name: "Base", series_number: 8, low_ask: null, fmv_usd: "100", discount_pct: null, external_id: "1:3" },
      { player_name: "NoFmv", tier: "MOMENT_TIER_RARE", set_name: "Base", series_number: 8, low_ask: "40", fmv_usd: null, discount_pct: null, external_id: "1:4" },
    ]
    const body = await (await POST(req({}))).json()
    expect(body.deals.map((d: any) => d.player_name)).toEqual(["NoFmv"])
    expect(body.deals[0].low_ask).toBe(40)
    expect(body.deals[0].discount_pct).toBeNull()
    expect(body.meta.avgDiscount).toBeNull()
  })
})
