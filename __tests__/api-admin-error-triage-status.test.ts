import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/error-triage/status (POST).
// verifyAdminRequest-gated proxy onto set_error_triage_status. Pins the
// fail-closed 401, signature-required 400, invalid-status 400, and a mocked
// happy path.

const rpc: { data: any; error: any } = { data: null, error: null }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { POST } from "@/app/api/admin/error-triage/status/route"

const ADMIN = "test-admin-token"

function post(body: unknown, auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/admin/error-triage/status", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  rpc.data = null
  rpc.error = null
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})

describe("POST /api/admin/error-triage/status", () => {
  it("401s fail-closed when RPC_ADMIN_TOKEN is unset", async () => {
    expect((await POST(post({ signature: "a", status: "open" }, `Bearer ${ADMIN}`))).status).toBe(401)
  })

  it("400s when signature is missing", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await POST(post({ status: "open" }, `Bearer ${ADMIN}`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("signature required")
  })

  it("400s on an invalid status value", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await POST(post({ signature: "a", status: "bogus" }, `Bearer ${ADMIN}`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("status must be one of")
  })

  it("returns ok on the happy path", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    rpc.data = { updated: 1 }
    const res = await POST(post({ signature: "a", status: "fixed" }, `Bearer ${ADMIN}`))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
})
