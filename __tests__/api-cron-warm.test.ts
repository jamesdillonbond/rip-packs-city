import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/warm.
// Auth: Bearer CRON_SECRET or INGEST_SECRET_TOKEN
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
//
// SUCCESS PATH: the warmer runs two market RPCs (get_topshot_sniper_deals,
// get_allday_market_listings) via supabaseAdmin.rpc AND a table read for the
// PUBLIC Underpriced-#1s board, then returns 200 { ok, elapsed_ms, warmed[] }.
// The Supabase client is mocked so all three resolve cleanly and the aggregate
// ok is observable without any DB I/O.
//
// ⚠ The mock must support BOTH shapes. It used to expose only `rpc`, so when the
// serials board (a `.from().select()...` chain, not an RPC) was added on
// 2026-08-27 the route threw, warmUnderpricedSerials returned ok:false and the
// aggregate went false — the test caught a real integration gap rather than a
// typo. A warmer mock that models only one access shape silently stops covering
// the moment a second shape is warmed.

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

// Chainable stub: every builder method returns `this`, and awaiting it resolves
// { data: [], error: null } — matching supabase-js, which RESOLVES rather than
// throwing. Covers .from().select().gte().eq().order().limit().
const tableStub: any = {
  select: () => tableStub,
  gte: () => tableStub,
  eq: () => tableStub,
  order: () => tableStub,
  limit: () => tableStub,
  then: (resolve: any) => resolve({ data: [], error: null }),
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => ({ data: [], error: null }),
    from: () => tableStub,
  },
}))

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/warm/route")
})

describe("GET /api/cron/warm", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.GET(makeReq({ method: "GET" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("GET /api/cron/warm — success path (both market RPCs warmed)", () => {
  it("200s and reports ok:true with the two warmed RPCs (INGEST bearer)", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.warmed)).toBe(true)
    expect(body.warmed).toHaveLength(3)
    expect(body.warmed.map((r: any) => r.rpc)).toEqual([
      "get_topshot_sniper_deals",
      "get_allday_market_listings",
      // The PUBLIC board that 503s cold (19,895ms cold / 32ms warm). Pinned by
      // NAME so removing it from the warmer is a visible test change, not a
      // silent regression back to a board nobody warms.
      "underpriced_serials_board",
    ])
    expect(body.warmed.every((r: any) => r.ok === true)).toBe(true)
  })

  it("200s with the CRON_SECRET bearer token too", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-cron-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
})
