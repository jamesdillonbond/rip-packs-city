import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/rewards/summary.
// Cookie-session auth via requireUser (401 Response when unauthed). On success
// it fires the capped daily_visit earn and fans out ~10 reads via Promise.all.
// Pins: unauth → 401, and a mocked authed happy path (all reads empty) → 200
// with the user id + defaulted blocks. @/lib/rewards, @/lib/pro, and the
// @/lib/supabase builder seam are all mocked.

// `errorOnTable` injects a supabase-js-shaped FAILURE for one table only.
// Per-table rather than global on purpose: a mock that fails every read would
// let the referralCount assertion below pass for the wrong reason.
const state: { user: any; summary: any; errorOnTable: string | null } = {
  user: { id: "u1" },
  summary: { spendable: 0 },
  errorOnTable: null,
}

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
  // ⚠ `from()` must return a builder that CLOSES OVER its table, not a shared
  // singleton. The route builds ~9 chains synchronously inside one Promise.all,
  // so a single mutable `table` field is overwritten by every later `.from()`
  // before any `then` settles — every chain would then resolve as the LAST
  // table. (Caught by this test failing against an already-correct route.)
  const chain = (table: string): any => {
    const c: any = {
      select: () => c,
      eq: () => c,
      not: () => c,
      order: () => c,
      limit: () => c,
      maybeSingle: async () => ({ data: null }),
      then: (resolve: any) => {
        if (state.errorOnTable && table === state.errorOnTable) {
          // ⚠ supabase-js RETURNS this shape — it does not throw. `count` is
          // null on a failed count, which is what `?? 0` used to swallow.
          return resolve({
            data: null,
            count: null,
            error: { code: "57014", message: "canceling statement due to statement timeout" },
          })
        }
        return resolve({ data: [], count: 0, error: null })
      },
    }
    return c
  }
  return { supabaseAdmin: { from: (t: string) => chain(t) } }
})

import { GET } from "@/app/api/rewards/summary/route"

beforeEach(() => {
  state.user = { id: "u1" }
  state.summary = { spendable: 0 }
  state.errorOnTable = null
})

describe("GET /api/rewards/summary", () => {
  it("401s when unauthenticated", async () => {
    state.user = null
    const res = await GET()
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("reports referralCount as null when the count read FAILS, never as 0", async () => {
    // ⚠ THE DISTINCTION: 0 means "you genuinely have no referrals", null means
    // "we could not read it". /rewards renders 0 as "No referrals yet — be the
    // first to share.", which is a claim about the reader's OWN account and
    // invites them to conclude their referrals never credited. supabase-js
    // RETURNS the error rather than throwing, so the old `referrals.count ?? 0`
    // published a hard 0 at HTTP 200 on a statement timeout.
    state.errorOnTable = "points_ledger"
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.referralCount).toBeNull()
    // The rest of the payload must be unaffected — this is a per-field
    // degradation, not a whole-page failure.
    expect(body.userId).toBe("u1")
  })

  it("reports referralCount as 0 when the read SUCCEEDS with none", async () => {
    // The other direction, and it is load-bearing: a genuinely-empty referral
    // count is an honest answer and must keep rendering as one, or the fix
    // above would just move the dishonesty.
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).referralCount).toBe(0)
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
