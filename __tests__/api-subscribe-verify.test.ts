import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/subscribe/verify. Token-gated confirmation
// endpoint. Since 2026-11-02 it renders its own PUBLIC page instead of redirecting
// to /dashboard (a sign-in wall for the anonymous confirmers the capture widgets
// produce). Mocks the supabaseAdmin .from().update().eq().select() chain.

const state: { error: any; patch: any; data: any } = { error: null, patch: null, data: [{ id: 1 }] }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    update: (p: any) => { state.patch = p; return b },
    eq: () => b,
    select: async () => ({ data: state.data, error: state.error }),
  }
  return { supabaseAdmin: { from: () => b }, supabase: { from: () => b } }
})

import { GET } from "@/app/api/subscribe/verify/route"

const req = (u: string) => ({ nextUrl: new URL(u), url: u }) as any

beforeEach(() => { state.error = null; state.patch = null; state.data = [{ id: 1 }] })

describe("GET /api/subscribe/verify", () => {
  it("never sends an anonymous confirmer to the /dashboard sign-in wall", async () => {
    for (const setup of [() => {}, () => { state.data = [] }, () => { state.error = { message: "db" } }]) {
      setup()
      const res = await GET(req("https://t/api/subscribe/verify?token=abc"))
      expect(res.headers.get("location")).toBeNull()
      expect(await res.text()).not.toContain("/dashboard")
    }
  })

  it("rejects a missing token without claiming a confirmation", async () => {
    const res = await GET(req("https://t/api/subscribe/verify"))
    expect(res.status).toBe(400)
    expect(await res.text()).not.toMatch(/confirmed|on the list/i)
  })

  it("confirms on a successful verify", async () => {
    const res = await GET(req("https://t/api/subscribe/verify?token=abc"))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("You're on the list")
  })

  // An update matching no row is not an error to PostgREST — the old route told
  // a stale or forged link "verified=true".
  it("does NOT claim a confirmation when the token matches no subscriber", async () => {
    state.data = []
    const res = await GET(req("https://t/api/subscribe/verify?token=abc"))
    expect(res.status).toBe(404)
    expect(await res.text()).not.toMatch(/confirmed|on the list/i)
  })

  // The click proves inbox control, so it is the one place an opt-out is
  // reversed — the anonymous POST /api/subscribe never touches an existing row.
  it("a verify click re-subscribes (clears unsubscribed_at) as well as verifying", async () => {
    await GET(req("https://t/api/subscribe/verify?token=abc"))
    expect(state.patch).toMatchObject({ verified: true, unsubscribed_at: null })
  })

  it("does not claim a confirmation when the update errors", async () => {
    state.error = { message: "db" }
    const res = await GET(req("https://t/api/subscribe/verify?token=abc"))
    expect(res.status).toBe(500)
    expect(await res.text()).not.toMatch(/confirmed|on the list/i)
  })
})
