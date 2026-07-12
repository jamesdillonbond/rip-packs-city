import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/auth/request-magic-link (soft-launch gate).
// Guards before sending any email: invalid JSON → 400, invalid email → 400, then
// the check_email_allowed service-role RPC gates the allow-list (error → 503,
// not allowed → 403). Mock @/lib/supabase (the gate RPC) + @supabase/supabase-js
// (the anon send client). We pin the 400/403/503 branches.

const gate: { data: any; error: any } = { data: true, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: gate.data, error: gate.error }) },
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { signInWithOtp: async () => ({ error: null }) } }),
}))

import { POST } from "@/app/api/auth/request-magic-link/route"

function req(raw?: string): NextRequest {
  return new NextRequest("https://t/api/auth/request-magic-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  })
}

beforeEach(() => {
  gate.data = true
  gate.error = null
})

describe("POST /api/auth/request-magic-link", () => {
  it("400s on invalid JSON", async () => {
    const res = await POST(req("not-json"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON body")
  })

  it("400s on a missing/invalid email", async () => {
    const res = await POST(req(JSON.stringify({ email: "nope" })))
    expect(res.status).toBe(400)
  })

  it("403s when the email is not on the allow-list", async () => {
    gate.data = false
    const res = await POST(req(JSON.stringify({ email: "user@example.com" })))
    expect(res.status).toBe(403)
    expect((await res.json()).reason).toBe("not_on_allow_list")
  })

  it("503s when the allow-list gate errors", async () => {
    gate.error = { message: "rpc down" }
    const res = await POST(req(JSON.stringify({ email: "user@example.com" })))
    expect(res.status).toBe(503)
  })
})
