import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/error-triage/instances (POST).
// verifyAdminRequest-gated proxy onto get_error_triage_instances. Pins the
// fail-closed 401, the signature-required 400, and a mocked happy path that
// passes the RPC JSONB through unchanged.

const rpc: { data: any; error: any } = { data: null, error: null }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { POST } from "@/app/api/admin/error-triage/instances/route"

const ADMIN = "test-admin-token"

function post(body: unknown, auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/admin/error-triage/instances", {
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

describe("POST /api/admin/error-triage/instances", () => {
  it("401s fail-closed when RPC_ADMIN_TOKEN is unset", async () => {
    expect((await POST(post({ signature: "abc" }, `Bearer ${ADMIN}`))).status).toBe(401)
  })

  it("400s when signature is missing", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await POST(post({}, `Bearer ${ADMIN}`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("signature required")
  })

  it("passes the RPC result through on the happy path", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    rpc.data = { found: 2, source: "sentry", instances: [{ id: 1 }, { id: 2 }] }
    const res = await POST(post({ signature: "sig-x" }, `Bearer ${ADMIN}`))
    expect(res.status).toBe(200)
    expect((await res.json()).found).toBe(2)
  })
})
