import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/trigger-backfill.
// Auth: ?token= / x-ingest-token / Bearer INGEST_SECRET_TOKEN (fail-closed)
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
//
// SUCCESS PATH: once authed the handler awaits a single internal POST to
// /api/fmv-recalc and echoes { success, status, result, triggeredAt }. There is
// no Supabase / after() here — global fetch is stubbed to a 200 so the accept is
// observable without hitting the network, and body.success mirrors res.ok.

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

vi.stubGlobal(
  "fetch",
  vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, message: "FMV recalc triggered" }),
  })),
)

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/trigger-backfill/route")
})

describe("POST /api/cron/trigger-backfill", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.POST(makeReq({ method: "POST" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("POST /api/cron/trigger-backfill — success path (fmv-recalc triggered)", () => {
  it("200s and echoes success:true + the downstream status with the bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.status).toBe(200)
    expect(body.result).toMatchObject({ message: "FMV recalc triggered" })
    expect(typeof body.triggeredAt).toBe("string")
  })

  it("200s via the ?token= query param too", async () => {
    const res = await mod.GET(makeReq({ method: "GET", token: "test-ingest-token" }))
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
  })
})
