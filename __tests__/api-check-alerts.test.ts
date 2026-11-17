import { describe, it, expect, vi } from "vitest"

// Route integration test for GET /api/check-alerts. Bearer-gated on
// INGEST_SECRET_TOKEN, which the route captures into a module-level const at
// import time — so we set it via vi.hoisted (runs BEFORE the module import) to
// make the wrong-token comparison meaningful. This is a FAIL-CLOSED AUTH test
// only: the success path returns 202 and pushes all real work (RPC + outbound
// email/Telegram) into an after() sweep with no clean synchronous seam, so we
// pin the auth rejection, not the sweep.

const SECRET = vi.hoisted(() => {
  process.env.INGEST_SECRET_TOKEN = "check-alerts-secret"
  return "check-alerts-secret"
})

// Keep NextResponse/NextRequest real, but neutralize after() so the deferred
// sweep never runs outside a request context during the 202 auth-pass test.
vi.mock("next/server", async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return { ...actual, after: () => {} }
})

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: [], error: null }), from: () => ({}) },
}))

import { GET } from "@/app/api/check-alerts/route"
import { makeReq } from "./cron-req-helper"

const URL = "https://t/api/check-alerts"

describe("GET /api/check-alerts", () => {
  it("401s with no Authorization header", async () => {
    const res = await GET(makeReq({ url: URL, method: "GET" }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("unauthorized")
  })

  it("401s with a wrong bearer token", async () => {
    const res = await GET(makeReq({ url: URL, method: "GET", auth: "Bearer wrong" }))
    expect(res.status).toBe(401)
  })

  it("does not reject a correctly-signed request at the auth gate (202)", async () => {
    const res = await GET(makeReq({ url: URL, method: "GET", auth: `Bearer ${SECRET}` }))
    expect(res.status).toBe(202)
  })
})
