import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/verify-challenge/check (POST only).
// On-demand live listing check — requireUser-gated. Pins the fail-closed 401,
// the wallet_addr 400, and the "no active challenge" 404 (empty challenge
// query short-circuits before the GQL/RPC resolve path).

const state: { user: any; challenges: any } = {
  user: null,
  challenges: { data: [], error: null },
}

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b, eq: () => b, is: () => b, gt: () => b, order: () => b, limit: () => b,
      then: (resolve: any) => resolve(state.challenges),
    }
    return b
  }
  const client: any = { from: () => build(), rpc: async () => ({ data: {}, error: null }) }
  return { supabase: client, supabaseAdmin: client }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user)
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    return state.user
  },
  getCurrentUser: async () => state.user,
}))

vi.mock("@/lib/verify-wallet-gql", () => ({
  fetchMomentListingState: async () => ({ forSale: false, price: null }),
  priceMatchesCents: () => false,
}))

import { POST } from "@/app/api/profile/verify-challenge/check/route"

const req = (body?: any) => ({ json: async () => body }) as any

beforeEach(() => {
  state.user = null
  state.challenges = { data: [], error: null }
})

describe("POST /api/profile/verify-challenge/check", () => {
  it("401s when unauthenticated (fail-closed)", async () => {
    expect((await POST(req({ wallet_addr: "0xabc" }))).status).toBe(401)
  })

  it("400s without a 0x wallet_addr", async () => {
    state.user = { id: "u1" }
    const res = await POST(req({ wallet_addr: "not-hex" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet_addr (0x...) required")
  })

  it("404s when there is no active challenge for the wallet", async () => {
    state.user = { id: "u1" }
    state.challenges = { data: [], error: null }
    const res = await POST(req({ wallet_addr: "0xabc" }))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("no_active_challenge")
  })
})
