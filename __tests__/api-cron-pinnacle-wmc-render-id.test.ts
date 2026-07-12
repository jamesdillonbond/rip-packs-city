import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/pinnacle-wmc-render-id.
// Auth: Bearer INGEST_SECRET_TOKEN or ?token= (module-const TOKEN, fail-closed via !TOKEN)
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
// Success path: the handler authenticates synchronously, defers ALL DB + GQL work
// into after() (stubbed no-op), and returns an immediate 202 accept — so the
// accept is observable without any Supabase/GQL I/O.

// after() is stubbed so the deferred candidate-select / GQL / update never runs.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
// Route builds its own client via createClient(); stub it inert (unused on the
// sync path since after() is a no-op, but mocked so no real client is created).
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({}),
    rpc: async () => ({ data: null, error: null }),
  }),
}))

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/pinnacle-wmc-render-id/route")
})

describe("GET /api/cron/pinnacle-wmc-render-id", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.GET(makeReq({ method: "GET" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("GET /api/cron/pinnacle-wmc-render-id — success path (immediate 202 accept)", () => {
  it("202s and reports the pipeline accept with the correct bearer token", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.pipeline).toBe("pinnacle-wmc-render-id")
    expect(typeof body.started_at).toBe("string")
  })

  it("202s with the correct ?token= query param", async () => {
    const res = await mod.GET(makeReq({ method: "GET", token: "test-ingest-token" }))
    expect(res.status).toBe(202)
    expect((await res.json()).accepted).toBe(true)
  })
})
