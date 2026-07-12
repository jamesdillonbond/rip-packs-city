import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/run-insider-detectors.
// Auth: Bearer INGEST_SECRET_TOKEN (module-const, fail-closed)
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
//
// Success path: the handler validates auth SYNCHRONOUSLY then returns 202
// { accepted:true } immediately, deferring the detector RPC + telemetry to
// after(). after() is stubbed no-op so the accept is observable without any DB
// I/O, and @/lib/supabase is stubbed inert as a belt-and-suspenders guard.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({}), rpc: async () => ({ data: null, error: null }) },
}))

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/run-insider-detectors/route")
})

describe("POST /api/cron/run-insider-detectors", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.POST(makeReq({ method: "POST" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("POST /api/cron/run-insider-detectors — success path (immediate 202 accept, work deferred)", () => {
  it("202s and reports accepted:true + the pipeline name with the INGEST bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.pipeline).toBe("run-insider-detectors")
    expect(typeof body.started_at).toBe("string")
  })
})
