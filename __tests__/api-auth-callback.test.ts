import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for GET /api/auth/callback (magic-link callback).
// Redirect guards (missing_code, error_description→auth_failed) PLUS the two
// session flows: the ?code= PKCE exchange (success + error) and the
// ?token_hash=&type= OTP verify (valid type success, invalid type, verify error).
// Success touches user_profiles (upsert error tolerated) and honors a same-site
// ?redirect=, falling back to "/" for an off-site value.

const st = vi.hoisted(() => ({
  exchange: { data: { user: { id: "u1" } } as { user: { id: string } } | null, error: null as any },
  verify: { data: { user: { id: "u1" } } as { user: { id: string } } | null, error: null as any },
  upsertErr: null as any,
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({ upsert: async () => ({ error: st.upsertErr }) }),
  },
}))
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      exchangeCodeForSession: async () => st.exchange,
      verifyOtp: async () => st.verify,
    },
  }),
}))

import { GET } from "@/app/api/auth/callback/route"

const req = (qs = "") => new NextRequest("https://t/api/auth/callback" + qs)

beforeEach(() => {
  st.exchange = { data: { user: { id: "u1" } }, error: null }
  st.verify = { data: { user: { id: "u1" } }, error: null }
  st.upsertErr = null
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://x"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon"
})

describe("GET /api/auth/callback — guards", () => {
  it("redirects to /login?error=missing_code with no actionable params", async () => {
    const res = await GET(req())
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toContain("/login?error=missing_code")
  })
  it("redirects to /login?error=auth_failed on an error_description (no code)", async () => {
    const loc = (await GET(req("?error_description=expired"))).headers.get("location") ?? ""
    expect(loc).toContain("error=auth_failed")
  })
})

describe("GET /api/auth/callback — code (PKCE) flow", () => {
  it("exchanges the code and redirects to a same-site ?redirect=", async () => {
    const res = await GET(req("?code=abc&redirect=/dashboard"))
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toContain("/dashboard")
  })
  it("falls back to / for an off-site redirect target", async () => {
    const res = await GET(req("?code=abc&redirect=https://evil.example/steal"))
    const loc = new URL(res.headers.get("location")!)
    expect(loc.pathname).toBe("/")
  })
  it("tolerates a user_profiles upsert error and still lands the session", async () => {
    st.upsertErr = { message: "profiles down" }
    expect((await GET(req("?code=abc"))).status).toBe(307)
  })
  it("redirects to auth_failed when the exchange errors", async () => {
    st.exchange = { data: null, error: { message: "bad code" } }
    const loc = (await GET(req("?code=abc"))).headers.get("location") ?? ""
    expect(loc).toContain("error=auth_failed")
    expect(loc).toContain("bad+code")
  })
})

describe("GET /api/auth/callback — token_hash / OTP flow", () => {
  it("verifies a magiclink OTP and lands the session", async () => {
    const res = await GET(req("?token_hash=th&type=magiclink"))
    expect(res.status).toBe(307)
    const loc = new URL(res.headers.get("location")!)
    expect(loc.pathname).toBe("/")
  })
  it("rejects an unsupported OTP type", async () => {
    const loc = (await GET(req("?token_hash=th&type=bogus"))).headers.get("location") ?? ""
    expect(loc).toContain("error=auth_failed")
    expect(loc).toContain("Unsupported+OTP+type")
  })
  it("redirects to auth_failed when verifyOtp errors", async () => {
    st.verify = { data: null, error: { message: "otp expired" } }
    const loc = (await GET(req("?token_hash=th&type=recovery"))).headers.get("location") ?? ""
    expect(loc).toContain("error=auth_failed")
  })
})
