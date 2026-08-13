import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/verify-challenge/check (POST only).
// On-demand live listing check — requireUser-gated. Pins the fail-closed 401,
// the wallet_addr 400, the "no active challenge" 404, and the not-matched 200.
// The mocks are state-driven so the deeper branches are reachable: the 429
// rate-limit, bad-json body, the challenge-query 500, the legacy-challenge 409,
// the GQL-unavailable 502, the confirmed-match success (resolve RPC + credits),
// the resolve-RPC 500, and the race (RPC returns { ok:false }). The referrer
// forwarding (valid uuid vs junk) is asserted on the captured RPC args.

const state: {
  user: any
  challenges: { data: any[] | null; error: any }
  gql: { forSale: boolean; price: number | null }
  gqlThrow: boolean
  priceMatch: boolean
  rpc: { data: any; error: any }
  lastRpc: { name: string; args: any } | null
} = {
  user: null,
  challenges: { data: [], error: null },
  gql: { forSale: false, price: null },
  gqlThrow: false,
  priceMatch: false,
  rpc: { data: {}, error: null },
  lastRpc: null,
}

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b, eq: () => b, is: () => b, gt: () => b, order: () => b, limit: () => b,
      then: (resolve: any) => resolve(state.challenges),
    }
    return b
  }
  const client: any = {
    from: () => build(),
    rpc: async (name: string, args: any) => {
      state.lastRpc = { name, args }
      return state.rpc
    },
  }
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
  fetchMomentListingState: async () => {
    if (state.gqlThrow) throw new Error("gql down")
    return state.gql
  },
  priceMatchesCents: () => state.priceMatch,
}))

import { POST } from "@/app/api/profile/verify-challenge/check/route"

const req = (body?: any) => ({ json: async () => body }) as any
const badJsonReq = () => ({ json: async () => { throw new Error("bad json") } }) as any

// An active, server-targeted challenge for the given amount.
const activeChallenge = (amount = 10) => ({
  data: [{ id: "c1", challenge_amount: amount, target_moment_id: "m1", expires_at: "2999-01-01T00:00:00Z" }],
  error: null,
})

beforeEach(() => {
  state.user = null
  state.challenges = { data: [], error: null }
  state.gql = { forSale: false, price: null }
  state.gqlThrow = false
  state.priceMatch = false
  state.rpc = { data: {}, error: null }
  state.lastRpc = null
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

  it("200s not-yet-matched when the target isn't listed at the challenge amount", async () => {
    state.user = { id: "u1" }
    state.challenges = activeChallenge(10)
    const res = await POST(req({ wallet_addr: "0xabc" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.matched).toBe(false)
    expect(body.hint).toContain("$10.00")
  })
})

describe("POST /api/profile/verify-challenge/check — guards & degrade paths", () => {
  it("429s once the per-user rate limit is exceeded", async () => {
    state.user = { id: "rate-user" } // isolated id so other tests' hits don't count
    // RATE_MAX is 6; the 7th call in the window trips the limiter. The first six
    // fall through to the (empty) challenge load and 404.
    for (let i = 0; i < 6; i++) {
      const r = await POST(req({ wallet_addr: "0xabc" }))
      expect(r.status).toBe(404)
    }
    const limited = await POST(req({ wallet_addr: "0xabc" }))
    expect(limited.status).toBe(429)
    expect((await limited.json()).error).toBe("rate_limited")
  })

  it("treats a bad-json body as {} and 400s on the missing wallet_addr", async () => {
    state.user = { id: "badjson-user" }
    const res = await POST(badJsonReq())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet_addr (0x...) required")
  })

  it("500s when the challenge lookup query errors", async () => {
    state.user = { id: "cherr-user" }
    state.challenges = { data: null, error: { message: "db boom" } }
    const res = await POST(req({ wallet_addr: "0xabc" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("db boom")
  })

  it("409s a legacy challenge that has no server-chosen target moment", async () => {
    state.user = { id: "legacy-user" }
    state.challenges = {
      data: [{ id: "c9", challenge_amount: 12, target_moment_id: null, expires_at: "2999-01-01T00:00:00Z" }],
      error: null,
    }
    const res = await POST(req({ wallet_addr: "0xabc" }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("legacy_challenge")
  })

  it("502s when the live Top Shot GQL check throws", async () => {
    state.user = { id: "gqlerr-user" }
    state.challenges = activeChallenge(15)
    state.gqlThrow = true
    const res = await POST(req({ wallet_addr: "0xabc" }))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe("gql_unavailable")
  })
})

describe("POST /api/profile/verify-challenge/check — confirmed match", () => {
  it("resolves the challenge (200 ok:true) and forwards a valid referrer uuid to the RPC", async () => {
    state.user = { id: "match-user" }
    state.challenges = activeChallenge(10)
    state.gql = { forSale: true, price: 1000 }
    state.priceMatch = true
    state.rpc = { data: { link_wallet_award: 500, referral_award: 250, ok: true }, error: null }

    const ref = "11111111-1111-1111-1111-111111111111"
    const res = await POST(req({ wallet_addr: "0xABC", ref }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.matched).toBe(true)
    expect(body.wallet).toBe("0xabc") // normalized lowercase
    expect(body.moment).toBe("m1")
    expect(body.link_wallet_award).toBe(500)
    expect(body.referral_award).toBe(250)

    expect(state.lastRpc?.name).toBe("resolve_wallet_challenge_match")
    expect(state.lastRpc?.args).toMatchObject({
      p_challenge_id: "c1",
      p_matched_moment_id: "m1",
      p_source: "gql_on_demand",
      p_referrer: ref,
    })
  })

  it("drops a malformed referrer (forwards p_referrer: null)", async () => {
    state.user = { id: "match-user-2" }
    state.challenges = activeChallenge(10)
    state.gql = { forSale: true, price: 1000 }
    state.priceMatch = true
    state.rpc = { data: { ok: true }, error: null }

    const res = await POST(req({ wallet_addr: "0xabc", ref: "not-a-uuid" }))
    expect(res.status).toBe(200)
    expect(state.lastRpc?.args?.p_referrer).toBeNull()
  })

  it("500s (matched:true) when the resolve RPC errors", async () => {
    state.user = { id: "resolve-err-user" }
    state.challenges = activeChallenge(10)
    state.gql = { forSale: true, price: 1000 }
    state.priceMatch = true
    state.rpc = { data: null, error: { message: "resolve failed" } }

    const res = await POST(req({ wallet_addr: "0xabc" }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.matched).toBe(true)
    expect(body.error).not.toContain("resolve failed")
  })

  it("returns the race result verbatim (200 matched:true) when the RPC reports ok:false", async () => {
    state.user = { id: "race-user" }
    state.challenges = activeChallenge(10)
    state.gql = { forSale: true, price: 1000 }
    state.priceMatch = true
    state.rpc = { data: { ok: false, reason: "already_resolved" }, error: null }

    const res = await POST(req({ wallet_addr: "0xabc" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.matched).toBe(true)
    expect(body.reason).toBe("already_resolved")
  })
})
