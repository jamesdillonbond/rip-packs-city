import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/refresh-pack-grail-metrics-mv.
// Auth: Bearer INGEST_SECRET_TOKEN
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
//
// Success path: auth is synchronous; the REFRESH MATERIALIZED VIEW + logging are
// deferred into after() and the route returns an immediate 202 accept. after() is
// stubbed to a no-op so the accept is observable without a request scope or any DB
// I/O; we assert the fixture-independent accept envelope (accepted + pipeline).

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/refresh-pack-grail-metrics-mv/route")
})

describe("POST /api/cron/refresh-pack-grail-metrics-mv", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.POST(makeReq({ method: "POST" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("POST /api/cron/refresh-pack-grail-metrics-mv — success path", () => {
  it("202-accepts with the correct bearer token (refresh deferred to after())", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.accepted).toBe(true)
    expect(body.pipeline).toBe("refresh-pack-grail-metrics-mv")
  })

  it("GET alias reaches the same 202 accept when authed", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
  })
})
