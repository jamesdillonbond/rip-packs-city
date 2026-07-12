import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/rewards/summary.
// Cookie-session auth via requireUser (401 Response when unauthed). On success
// it fires the capped daily_visit earn and fans out ~10 reads via Promise.all.
// Pins: unauth → 401, and a mocked authed happy path (all reads empty) → 200
// with the user id + defaulted blocks. @/lib/rewards, @/lib/pro, and the
// @/lib/supabase builder seam are all mocked.

const state: { user: any; summary: any } = { user: { id: "u1" }, summary: { spendable: 0 } }

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user)
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    return state.user
  },
}))
vi.mock("@/lib/rewards", () => ({
  awardPoints: async () => ({ awarded: false }),
  getRewardsSummary: async () => state.summary,
}))
vi.mock("@/lib/pro", () => ({
  getProStatus: async () => ({ isPro: false, plan: null, expiresAt: null }),
}))
vi.mock("@/lib/supabase", () => {
  const b: any = {
    from: () => b,
    select: () => b,
    eq: () => b,
    not: () => b,
    order: () => b,
    limit: () => b,
    maybeSingle: async () => ({ data: null }),
    then: (resolve: any) => resolve({ data: [], count: 0, error: null }),
  }
  return { supabaseAdmin: b }
})

import { GET } from "@/app/api/rewards/summary/route"

beforeEach(() => {
  state.user = { id: "u1" }
  state.summary = { spendable: 0 }
})

describe("GET /api/rewards/summary", () => {
  it("401s when unauthenticated", async () => {
    state.user = null
    const res = await GET()
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("returns the authed summary payload", async () => {
    state.user = { id: "u1" }
    state.summary = { spendable: 500, status: "active" }
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.userId).toBe("u1")
    expect(body.summary).toEqual({ spendable: 500, status: "active" })
    expect(body.rules).toEqual([])
    expect(body.shop).toEqual([])
    expect(body.pro).toEqual({ isPro: false, plan: null, expiresAt: null })
    expect(body.hasVerifiedWallet).toBe(false)
  })
})
