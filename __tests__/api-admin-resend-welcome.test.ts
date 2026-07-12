import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/resend-welcome (POST).
// verifyAdminRequest-gated. Pins the fail-closed 401, invalid-JSON 400, and
// email-required 400 (all resolve before any DB call).

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({}) } }))
vi.mock("@/lib/allow-list/prewarm", () => ({ processSinglePrewarmRow: async () => ({ ok: true }) }))

import { POST } from "@/app/api/admin/resend-welcome/route"

const ADMIN = "test-admin-token"

function post(body: unknown, auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/admin/resend-welcome", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})

describe("POST /api/admin/resend-welcome", () => {
  it("401s fail-closed when RPC_ADMIN_TOKEN is unset", async () => {
    expect((await POST(post({ email: "a@b.com" }, `Bearer ${ADMIN}`))).status).toBe(401)
  })

  it("400s on invalid JSON", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await POST(post("{bad", `Bearer ${ADMIN}`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON body")
  })

  it("400s when email is missing or malformed", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await POST(post({ email: "not-an-email" }, `Bearer ${ADMIN}`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("email required")
  })
})
