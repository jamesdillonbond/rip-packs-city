import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/verify-challenge (POST/GET/PATCH).
// The listing-challenge mint/read flow — requireUser-gated on every verb. POST's
// live-mint happy path runs GQL + on-chain Cadence walks, so it is pinned at the
// fail-closed 401 + param guards + the 200 "indexing" accept (empty candidate
// set → no listable target, no wmc rows). GET's happy path is fully mockable:
// with an active challenge row it returns 200 { challenge, target }. after() is
// stubbed so the POST cold-wallet backfill kick never needs a request scope.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})

const state: { user: any; query: any } = { user: null, query: { data: [], error: null, count: 0 } }

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b, insert: () => b, update: () => b, eq: () => b, is: () => b,
      gt: () => b, like: () => b, or: () => b, order: () => b, limit: () => b,
      single: async () => ({ data: null, error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: any) => resolve(state.query),
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
  state.query = { data: [], error: null, count: 0 }
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

  it("POST 200s 'indexing' when the wallet has no verifiable moments (empty cache)", async () => {
    // saved_wallets lookup returns the wallet (data:[row]); candidate picks +
    // wmc count all resolve empty via the shared query fixture → cold-wallet path.
    state.user = { id: "u1" }
    state.query = { data: [{ wallet_addr: "0xabc" }], error: null, count: 0 }
    const res = await POST(postReq({ wallet_addr: "0xabc" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.challenge).toBeNull()
    expect(body.unavailable).toBe(true)
  })

  it("GET 200s and returns the active challenge for the wallet", async () => {
    state.user = { id: "u1" }
    state.query = {
      data: [{ id: "ch1", wallet_addr: "0xabc", challenge_amount: 10, expires_at: "2999-01-01T00:00:00Z", resolved_at: null, target_moment_id: null }],
      error: null,
    }
    const res = await GET(getReq("https://t/api/profile/verify-challenge?wallet_addr=0xabc"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.challenge.id).toBe("ch1")
    expect(body.challenge.expired).toBe(false)
  })
})
