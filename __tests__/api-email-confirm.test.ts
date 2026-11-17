import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/email/confirm. No auth — the token IS the
// bearer. Every path 302/307-redirects to /dashboard/notifications with a
// ?confirm=<status>. Mocks @/lib/supabase supabaseAdmin: the lookup uses
// .from().select().eq().maybeSingle(); the verify write uses
// .from().update().eq() (awaited → thenable). Pins missing-token, unknown-token,
// and already-verified (ok) branches via the redirect Location header.

const state: { row: { data: any; error: any }; update: { error: any } } = {
  row: { data: null, error: null },
  update: { error: null },
}

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b,
    eq: () => b,
    update: () => b,
    maybeSingle: async () => state.row,
    then: (resolve: any) => resolve(state.update),
  }
  return { supabaseAdmin: { from: () => b } }
})

import { GET } from "@/app/api/email/confirm/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any
const loc = (res: any) => res.headers.get("location") ?? ""

beforeEach(() => {
  state.row = { data: null, error: null }
  state.update = { error: null }
})

describe("GET /api/email/confirm", () => {
  it("redirects with confirm=missing when no token is present", async () => {
    const res = await GET(req("https://t/api/email/confirm"))
    expect(res.status).toBeGreaterThanOrEqual(300)
    expect(res.status).toBeLessThan(400)
    expect(loc(res)).toContain("confirm=missing")
  })

  it("redirects with confirm=unknown_token for an unrecognised token", async () => {
    state.row = { data: null, error: null }
    const res = await GET(req("https://t/api/email/confirm?token=abc"))
    expect(loc(res)).toContain("confirm=unknown_token")
  })

  it("redirects with confirm=ok when the row is already verified", async () => {
    state.row = { data: { id: "s1", email: "a@b.com", verified: true }, error: null }
    const res = await GET(req("https://t/api/email/confirm?token=abc"))
    expect(loc(res)).toContain("confirm=ok")
  })

  it("verifies an unverified row and redirects with confirm=ok", async () => {
    state.row = { data: { id: "s1", email: "a@b.com", verified: false }, error: null }
    state.update = { error: null }
    const res = await GET(req("https://t/api/email/confirm?token=abc"))
    expect(loc(res)).toContain("confirm=ok")
  })
})
