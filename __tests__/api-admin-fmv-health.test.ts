import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/fmv-health (GET).
// isAuthorized(): Bearer INGEST_SECRET_TOKEN OR RPC_ADMIN_TOKEN, fail-closed.
// Wraps get_fmv_calibration_caps_summary. Pins the fail-closed 401 and a
// mocked happy path that computes the by_reason strip.

const rpc: { data: any; error: any } = { data: null, error: null }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/admin/fmv-health/route"

const ADMIN = "test-admin-token"

function req(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/admin/fmv-health?windowHours=24", { headers })
}

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  rpc.data = null
  rpc.error = null
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})

describe("GET /api/admin/fmv-health", () => {
  it("401s fail-closed when no token env is set", async () => {
    expect((await GET(req(`Bearer ${ADMIN}`))).status).toBe(401)
  })

  it("returns total_caps + by_reason on the happy path", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    rpc.data = [{ reason: "thin_sales" }, { reason: "thin_sales" }, { reason: "spread" }]
    const res = await GET(req(`Bearer ${ADMIN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.total_caps).toBe(3)
    expect(body.by_reason.thin_sales).toBe(2)
    expect(body.window_hours).toBe(24)
  })

  it("500s on an RPC error", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    rpc.error = { message: "boom" }
    expect((await GET(req(`Bearer ${ADMIN}`))).status).toBe(500)
  })
})
