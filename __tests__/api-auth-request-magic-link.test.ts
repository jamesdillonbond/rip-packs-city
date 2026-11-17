import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/auth/request-magic-link (soft-launch gate).
// Guards before sending any email: invalid JSON -> 400, invalid email -> 400, then
// the check_email_allowed service-role RPC gates the allow-list (error -> 503,
// not allowed -> 403). PLUS the 2xx success path: allow-listed + a successful
// signInWithOtp -> 200 { ok: true }. Mock @/lib/supabase (the gate RPC) +
// @supabase/supabase-js (the anon send client).

const gate: { data: any; error: any } = { data: true, error: null }
// the durable send cap (2026-10-10)
const rate = vi.hoisted(() => ({ verdict: { data: { allowed: true }, error: null } as { data: any; error: any }, sends: 0 }))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (fn: string) =>
      fn === "bump_anon_action_rate" ? rate.verdict : { data: gate.data, error: gate.error },
  },
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { signInWithOtp: async () => { rate.sends++; return { error: null } } } }),
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
  rate.verdict = { data: { allowed: true }, error: null }
  rate.sends = 0
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

  it("200s { ok: true } when allow-listed and the OTP send succeeds", async () => {
    gate.data = true
    const res = await POST(req(JSON.stringify({ email: "user@example.com" })))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  // 2026-10-10: allow-by-default, so this mailed ANY address with no durable cap.
  it("a refused send cap sends NO mail (429)", async () => {
    rate.verdict = { data: { allowed: false }, error: null }
    const res = await POST(req(JSON.stringify({ email: "victim@example.com" })))
    expect(res.status).toBe(429)
    expect(rate.sends).toBe(0)
  })

  it("an unreadable cap FAILS CLOSED (503), no mail", async () => {
    rate.verdict = { data: null, error: { message: "timeout" } }
    const res = await POST(req(JSON.stringify({ email: "user@example.com" })))
    expect(res.status).toBe(503)
    expect(rate.sends).toBe(0)
  })
})
