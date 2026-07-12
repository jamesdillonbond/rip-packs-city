import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/verify-challenge (POST/GET/PATCH).
// The listing-challenge mint/read flow — requireUser-gated on every verb. The
// happy paths run live GQL + on-chain Cadence walks (not a simple mockable
// seam), so this pins the fail-closed 401s and the param guards that return
// before any of that: POST invalid-JSON 400, POST/GET wallet_addr 400.

const state: { user: any } = { user: null }

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b, insert: () => b, update: () => b, eq: () => b, is: () => b,
      gt: () => b, like: () => b, or: () => b, order: () => b, limit: () => b,
      single: async () => ({ data: null, error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: any) => resolve({ data: [], error: null, count: 0 }),
    }
    return b
  }
  const client: any = { from: () => build(), rpc: async () => ({ data: [], error: null }) }
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
  fetchMomentListingState: async () => ({ found: true, isLocked: false, forSale: false, price: null }),
  topShotMomentUrl: (id: string) => `https://nbatopshot.com/moment/${id}`,
}))

vi.mock("@/lib/chains/flow/wallet-backfill-helpers", () => ({
  fetchOnChainIds: async () => [],
}))

import { POST, GET } from "@/app/api/profile/verify-challenge/route"

const postReq = (body?: any, throws = false) =>
  ({
    url: "https://t/api/profile/verify-challenge",
    json: async () => {
      if (throws) throw new Error("bad json")
      return body
    },
  }) as any

const getReq = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.user = null
})

describe("/api/profile/verify-challenge", () => {
  it("POST 401s when unauthenticated (fail-closed)", async () => {
    expect((await POST(postReq({ wallet_addr: "0xabc" }))).status).toBe(401)
  })

  it("GET 401s when unauthenticated (fail-closed)", async () => {
    expect((await GET(getReq("https://t/api/profile/verify-challenge?wallet_addr=0xabc"))).status).toBe(401)
  })

  it("POST 400s on invalid JSON body", async () => {
    state.user = { id: "u1" }
    const res = await POST(postReq(undefined, true))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON body")
  })

  it("POST 400s without a 0x wallet_addr", async () => {
    state.user = { id: "u1" }
    const res = await POST(postReq({ wallet_addr: "not-hex" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet_addr (0x...) required")
  })

  it("GET 400s without a 0x wallet_addr", async () => {
    state.user = { id: "u1" }
    const res = await GET(getReq("https://t/api/profile/verify-challenge"))
    expect(res.status).toBe(400)
  })

  it("exports handler functions for POST/GET", () => {
    expect(typeof POST).toBe("function")
    expect(typeof GET).toBe("function")
  })
})
