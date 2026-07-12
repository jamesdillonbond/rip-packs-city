import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/subscribe/verify. Token-gated redirect
// endpoint: no token → redirect to ?verified=false, a successful update →
// ?verified=true, a DB error → ?verified=false. Mocks the supabaseAdmin
// .from().update().eq() chain.

const state: { error: any } = { error: null }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    update: () => b,
    eq: async () => ({ error: state.error }),
  }
  return { supabaseAdmin: { from: () => b }, supabase: { from: () => b } }
})

import { GET } from "@/app/api/subscribe/verify/route"

const req = (u: string) => ({ nextUrl: new URL(u), url: u }) as any

beforeEach(() => { state.error = null })

describe("GET /api/subscribe/verify", () => {
  it("redirects to verified=false without a token", async () => {
    const res = await GET(req("https://t/api/subscribe/verify"))
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toContain("verified=false")
  })

  it("redirects to verified=true on a successful verify", async () => {
    const res = await GET(req("https://t/api/subscribe/verify?token=abc"))
    expect(res.headers.get("location")).toContain("verified=true")
  })

  it("redirects to verified=false when the update errors", async () => {
    state.error = { message: "db" }
    const res = await GET(req("https://t/api/subscribe/verify?token=abc"))
    expect(res.headers.get("location")).toContain("verified=false")
  })
})
