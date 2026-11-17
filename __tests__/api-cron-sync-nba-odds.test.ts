import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/sync-nba-odds.
// Auth: Bearer INGEST_SECRET_TOKEN/CRON_SECRET or ?token= (INGEST captured at
// import time as a module const).
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
//
// Success path is SYNCHRONOUS: the route fans out to the sync-nba-odds edge fn
// (which itself hits the external odds API) via a single fetch, then returns 202
// { accepted:true, edge_status, edge_body } when the edge fn responds ok. We stub
// global fetch so the edge/upstream I/O never runs and the 202 accept is driven
// from a fixture — no live odds API involvement.

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://stub.supabase.co"

vi.stubGlobal(
  "fetch",
  vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ synced: true, games: 3 }),
  })),
)

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/sync-nba-odds/route")
})

describe("GET /api/cron/sync-nba-odds", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.GET(makeReq({ method: "GET" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("GET /api/cron/sync-nba-odds — success path (edge fan-out stubbed)", () => {
  it("202s with accepted:true and surfaces the edge status/body when the edge fn responds ok", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.edge_status).toBe(200)
    expect(body.edge_body).toEqual({ synced: true, games: 3 })
  })

  it("POST alias reaches the same 202 accept when authed", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
  })
})
