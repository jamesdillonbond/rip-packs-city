import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"

// Route-integration test for /api/cron/topshot-insider-detect-patterns.
// Auth: Bearer INGEST_SECRET_TOKEN/CRON_SECRET or ?token=
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
//
// SUCCESS PATH: an authed request forwards to the Supabase edge function
// `topshot-insider-detect-patterns` via fetch and returns 202 with
// {accepted:true, edge_status, edge_body} shaped from the edge response. global
// fetch is stubbed to a benign 200 JSON body so the accept is observable with no
// real network — we assert edge_status and a fixture-derived edge_body field.

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://stub.supabase.co"

import { makeReq } from "./cron-req-helper"

let mod: any
const realFetch = global.fetch
beforeAll(async () => {
  mod = await import("@/app/api/cron/topshot-insider-detect-patterns/route")
})
afterAll(() => {
  global.fetch = realFetch
})

describe("GET /api/cron/topshot-insider-detect-patterns", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.GET(makeReq({ method: "GET" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("GET /api/cron/topshot-insider-detect-patterns — success path", () => {
  it("202s and reports the edge status/body when the edge function returns ok", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ patterns_detected: 3, alerts_sent: 1 }),
    })) as any
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.edge_status).toBe(200)
    expect(body.edge_body.patterns_detected).toBe(3)
  })

  it("POST alias reaches the same accept when authed", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ patterns_detected: 0 }),
    })) as any
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
    expect((await res.json()).accepted).toBe(true)
  })
})
