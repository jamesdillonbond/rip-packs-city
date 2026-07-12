import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/email/subscribe (POST + GET). Cookie-auth via
// @/lib/auth/supabase-server getCurrentUser. Pins the 401-when-unauthenticated
// guard on both verbs, the POST invalid-JSON 400, and a POST happy path where
// the upserted row is already verified (so no Resend email is sent — no fetch).
// Mocks @/lib/supabase supabaseAdmin: POST uses .from().upsert().select()
// .maybeSingle(); GET uses .from().select().ilike().maybeSingle().

const state: { user: any; row: { data: any; error: any } } = {
  user: null,
  row: { data: null, error: null },
}

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => state.user,
}))

vi.mock("@/lib/supabase", () => {
  const b: any = {
    upsert: () => b,
    select: () => b,
    ilike: () => b,
    maybeSingle: async () => state.row,
  }
  return { supabaseAdmin: { from: () => b } }
})

import { POST, GET } from "@/app/api/email/subscribe/route"

function postReq(body: any, badJson = false): any {
  return { json: async () => { if (badJson) throw new Error("bad json"); return body } }
}

beforeEach(() => {
  state.user = null
  state.row = { data: null, error: null }
})

describe("POST /api/email/subscribe", () => {
  it("401s when unauthenticated", async () => {
    state.user = null
    const res = await POST(postReq({}))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("400s on invalid JSON for an authed user", async () => {
    state.user = { email: "a@b.com" }
    const res = await POST(postReq(null, true))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON body")
  })

  it("upserts prefs and skips the email when the row is already verified", async () => {
    state.user = { email: "A@B.com" }
    state.row = {
      data: { id: "s1", email: "a@b.com", verified: true, verification_token: "tok" },
      error: null,
    }
    const res = await POST(postReq({ digest_weekly: true }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.verified).toBe(true)
    expect(body.confirmation_email_sent).toBe(false)
  })
})

describe("GET /api/email/subscribe", () => {
  it("401s when unauthenticated", async () => {
    state.user = null
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it("returns the subscriber row for an authed user", async () => {
    state.user = { email: "a@b.com" }
    state.row = { data: { id: "s1", email: "a@b.com", verified: true }, error: null }
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.subscriber.id).toBe("s1")
  })
})
