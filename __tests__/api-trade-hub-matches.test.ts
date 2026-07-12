import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/trade-hub/matches. Cookie-auth gated →
// fail-closed 401 when unauthenticated (getCurrentUser → null). Success path:
// a signed-in user reads their pending trade_matches — mock the auth helper to
// a user and supabaseAdmin's chain to resolve a fixture row, assert it is
// echoed back on { ok, matches }.

const state: { user: any; matches: any } = { user: null, matches: { data: [], error: null } }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b, or: () => b, is: () => b, order: () => b, limit: () => b,
    then: (resolve: any) => resolve(state.matches),
  }
  return { supabaseAdmin: { from: () => b, rpc: async () => ({ data: null, error: null }) } }
})
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => state.user }))

import { GET } from "@/app/api/trade-hub/matches/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => {
  state.user = null
  state.matches = { data: [], error: null }
})

describe("GET /api/trade-hub/matches", () => {
  it("401s when unauthenticated", async () => {
    expect((await GET(req("https://t/api/trade-hub/matches"))).status).toBe(401)
  })

  it("200s and returns the caller's pending matches", async () => {
    state.user = { id: "u1" }
    state.matches = { data: [{ id: "m1", match_score: 90, buyer_user_id: "u1" }], error: null }
    const res = await GET(req("https://t/api/trade-hub/matches"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.matches).toHaveLength(1)
    expect(body.matches[0].id).toBe("m1")
  })
})
