import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/warm.
// Auth: Bearer CRON_SECRET or INGEST_SECRET_TOKEN
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
//
// SUCCESS PATH: the warmer runs two market RPCs (get_topshot_sniper_deals,
// get_allday_market_listings) SYNCHRONOUSLY via supabaseAdmin.rpc and returns
// 200 { ok, elapsed_ms, warmed[] }. The Supabase client is mocked so both RPCs
// resolve cleanly (error:null → warmRpc ok) and the aggregate ok is observable
// without any DB I/O.

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: [], error: null }) },
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
    expect(body.warmed).toHaveLength(2)
    expect(body.warmed.map((r: any) => r.rpc)).toEqual([
      "get_topshot_sniper_deals",
      "get_allday_market_listings",
    ])
    expect(body.warmed.every((r: any) => r.ok === true)).toBe(true)
  })

  it("200s with the CRON_SECRET bearer token too", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-cron-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
})
