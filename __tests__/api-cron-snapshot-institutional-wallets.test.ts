import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/snapshot-institutional-wallets.
// Auth: Bearer INGEST_SECRET_TOKEN/CRON_SECRET or ?token= (INGEST captured at
// import time as a module const).
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
//
// Success path is SYNCHRONOUS on this route (no after()): it awaits a
// cron_heartbeat upsert (@/lib/supabase rpc) then invokeEdgeWithRetry (global
// fetch to the edge fn) and, on an ok upstream, returns 202
// { accepted:true, edge_status, edge_body, attempts }. supabaseAdmin is stubbed
// inert and fetch is stubbed to a 202 with a JSON body, so the accept is driven
// without any real DB/network I/O.

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({}), rpc: async () => ({ data: null, error: null }) },
}))

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://stub.supabase.co"

vi.stubGlobal(
  "fetch",
  vi.fn(async () => ({
    ok: true,
    status: 202,
    text: async () => JSON.stringify({ queued: true }),
  })),
)

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/snapshot-institutional-wallets/route")
})

describe("GET /api/cron/snapshot-institutional-wallets", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.GET(makeReq({ method: "GET" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("GET /api/cron/snapshot-institutional-wallets — success path (heartbeat + edge invoke)", () => {
  it("202s with accepted:true and surfaces the edge status/body when the edge fn accepts", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.edge_status).toBe(202)
    expect(body.edge_body).toEqual({ queued: true })
    expect(body.attempts).toBe(1)
  })

  it("POST alias reaches the same 202 accept when authed", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
  })
})
