import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/refresh-conflated-editions.
// Auth: Bearer INGEST_SECRET_TOKEN
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
// Success path: the handler authenticates synchronously, defers the remap +
// refresh RPCs + log_pipeline_run into after() (stubbed no-op), and returns an
// immediate 202 accept — observable without any Supabase I/O.

// after() is stubbed so the deferred remap/refresh RPCs never run.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
// Route builds its own client via createClient(); stub it inert.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({}),
    rpc: async () => ({ data: 0, error: null }),
  }),
}))

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/refresh-conflated-editions/route")
})

describe("POST /api/cron/refresh-conflated-editions", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.POST(makeReq({ method: "POST" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("POST /api/cron/refresh-conflated-editions — success path (immediate 202 accept)", () => {
  it("202s and reports the pipeline accept with the correct bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.accepted).toBe(true)
    expect(body.pipeline).toBe("refresh-conflated-editions")
  })

  it("GET alias reaches the same 202 accept when authed", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
    expect((await res.json()).accepted).toBe(true)
  })
})
