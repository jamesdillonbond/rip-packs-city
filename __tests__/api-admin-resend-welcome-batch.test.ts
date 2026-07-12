import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/resend-welcome-batch (POST).
// verifyAdminRequest-gated. Requires either body.emails[] or ?dormant_since_days.
// Pins the fail-closed 401 and the 400 when neither input mode is supplied.

vi.mock("@/lib/supabase", () => {
  const sb: any = {
    rpc: async () => ({ data: null, error: null }),
    from: () => sb,
    select: () => sb,
    update: () => sb,
    eq: async () => ({ data: null, error: null }),
    in: async () => ({ data: [], error: null }),
  }
  return { supabaseAdmin: sb }
})
vi.mock("@/lib/allow-list/prewarm", () => ({ processSinglePrewarmRow: async () => ({ ok: true }) }))

import { POST } from "@/app/api/admin/resend-welcome-batch/route"

const ADMIN = "test-admin-token"

function post(body: unknown, auth?: string, query = ""): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest(`https://t/api/admin/resend-welcome-batch${query}`, {
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

describe("POST /api/admin/resend-welcome-batch", () => {
  it("401s fail-closed when RPC_ADMIN_TOKEN is unset", async () => {
    expect((await POST(post({ emails: ["a@b.com"] }, `Bearer ${ADMIN}`))).status).toBe(401)
  })

  it("400s when neither emails[] nor ?dormant_since_days is provided", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await POST(post({}, `Bearer ${ADMIN}`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("Provide either body.emails")
  })

  it("200s an emails-mode run matching 0 rows when none are active (authed)", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await POST(post({ emails: ["a@b.com"] }, `Bearer ${ADMIN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.mode).toBe("emails")
    expect(body.matched).toBe(0)
    expect(body.processed).toBe(0)
  })
})
