import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/error-triage/list (POST).
// verifyAdminRequest-gated proxy onto get_error_triage_summary. Body is
// optional (bad JSON is swallowed to {}). Pins the fail-closed 401 and a
// mocked happy path returning { rows }.

const rpc: { data: any; error: any } = { data: null, error: null }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { POST } from "@/app/api/admin/error-triage/list/route"

const ADMIN = "test-admin-token"

function post(body: unknown, auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/admin/error-triage/list", {
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

describe("POST /api/admin/error-triage/list", () => {
  it("401s fail-closed when RPC_ADMIN_TOKEN is unset", async () => {
    expect((await POST(post({}, `Bearer ${ADMIN}`))).status).toBe(401)
  })

  it("returns { rows } from the RPC on the happy path", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    rpc.data = [{ signature: "a", n: 3 }]
    const res = await POST(post({ status_filter: "open" }, `Bearer ${ADMIN}`))
    expect(res.status).toBe(200)
    expect((await res.json()).rows).toHaveLength(1)
  })

  it("500s on an RPC error", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    rpc.error = { message: "db down" }
    const res = await POST(post({}, `Bearer ${ADMIN}`))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })
})
