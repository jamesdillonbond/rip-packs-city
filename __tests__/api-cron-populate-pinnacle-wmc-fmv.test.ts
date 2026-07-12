import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/populate-pinnacle-wmc-fmv.
// Auth: Bearer INGEST_SECRET_TOKEN (module-const TOKEN, fail-closed)
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
// Success path: the handler authenticates synchronously, defers the FMV RPC +
// log_pipeline_run into after() (stubbed no-op), and returns an immediate 202
// accept — observable without any Supabase I/O.

// after() is stubbed so the deferred populate_pinnacle_wmc_fmv RPC never runs.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
// Route imports supabaseAdmin from "@/lib/supabase"; stub it inert.
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({}), rpc: async () => ({ data: null, error: null }) },
}))

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/populate-pinnacle-wmc-fmv/route")
})

describe("POST /api/cron/populate-pinnacle-wmc-fmv", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.POST(makeReq({ method: "POST" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("POST /api/cron/populate-pinnacle-wmc-fmv — success path (immediate 202 accept)", () => {
  it("202s and reports the pipeline accept with the correct bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.pipeline).toBe("populate-pinnacle-wmc-fmv")
    expect(typeof body.started_at).toBe("string")
  })
})
