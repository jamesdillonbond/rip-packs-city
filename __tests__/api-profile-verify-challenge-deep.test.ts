import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeSupabaseFixture } from "./helpers/route-harness"

// Deep test for /api/profile/verify-challenge — drives the listing-challenge
// mint flow (saved-wallet gate → candidate pick → on-chain ownership gate → live
// GQL listing-state filter → supersede + insert), the GET target-card enrichment,
// and the PATCH resolver pass. The shallow test only pins auth + the empty-cache
// "indexing" accept; here the on-chain / GQL seams are stubbed so the real happy
// paths run and we assert the COMPUTED challenge + target shapes.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  user: null as null | { id: string },
  ownedIds: [] as string[],
  throwOnChain: false,
  listingThrows: false,
  listingState: { found: true, isLocked: false, forSale: false, price: null as number | null },
}))

// The cold-wallet / re-walk branches fire a fire-and-forget backfill only when
// INGEST_SECRET_TOKEN is set (after() is mocked to a no-op below, so nothing
// actually goes out). Setting it exercises the `if (token)` true side.
process.env.INGEST_SECRET_TOKEN = "vc-token"

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => {
  const client = new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] })
  return { supabaseAdmin: client, supabase: client }
})
vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user) {
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }
    return state.user
  },
}))
vi.mock("@/lib/verify-wallet-gql", () => ({
  fetchMomentListingState: async () => {
    if (state.listingThrows) throw new Error("Top Shot GQL HTTP 530: origin unreachable")
    return state.listingState
  },
  topShotMomentUrl: (id: string) => `https://nbatopshot.com/moment/${id}`,
}))
vi.mock("@/lib/chains/flow/wallet-backfill-helpers", () => ({
  fetchOnChainIds: async () => {
    if (state.throwOnChain) throw new Error("flow access node down")
    return state.ownedIds
  },
}))

import { POST, GET, PATCH } from "@/app/api/profile/verify-challenge/route"

function install(fixtures: Record<string, unknown>) {
  state.sb = makeSupabaseFixture(fixtures as never)
}

const postReq = (body?: unknown) =>
  ({ url: "https://t/api/profile/verify-challenge", json: async () => body }) as never
const getReq = (u: string) => ({ nextUrl: new URL(u) }) as never

beforeEach(() => {
  state.sb = null
  state.user = null
  state.ownedIds = []
  state.throwOnChain = false
  state.listingState = { found: true, isLocked: false, forSale: false, price: null }
})

describe("POST /api/profile/verify-challenge — mint flow", () => {
  it("403s when the wallet is not saved on the account", async () => {
    state.user = { id: "u1" }
    install({ saved_wallets: { data: [], error: null } })
    const res = await POST(postReq({ wallet_addr: "0xABC" }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("Wallet not saved on this account")
  })

  it("mints a challenge for the first owned, unlocked, unlisted candidate and returns the target card", async () => {
    state.user = { id: "u1" }
    state.ownedIds = ["m1"] // on-chain ownership gate keeps candidate m1
    install({
      saved_wallets: { data: [{ wallet_addr: "0xabc" }], error: null },
      "rpc:pick_verification_target": {
        data: [
          {
            moment_id: "m1",
            edition_key: "3:45",
            serial_number: 5,
            player_name: "Dame",
            set_name: "Base Set",
            image_url: "http://img",
            fmv_usd: 0.5,
          },
        ],
        error: null,
      },
      wallet_verification_challenges: [
        { data: null, error: null }, // supersede update
        {
          data: {
            id: "ch1",
            wallet_addr: "0xabc",
            challenge_amount: 50.42,
            created_at: "2026-07-17T00:00:00Z",
            expires_at: "2999-01-01T00:00:00Z",
            resolved_at: null,
            resolved_via: null,
            matched_moment_id: null,
            target_moment_id: "m1",
          },
          error: null,
        }, // insert().select().single()
      ],
    })

    const res = await POST(postReq({ wallet_addr: "0xABC" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.challenge.id).toBe("ch1")
    expect(body.challenge.expired).toBe(false)
    expect(body.challenge.msRemaining).toBeGreaterThan(0)
    expect(body.target).toMatchObject({
      moment_id: "m1",
      edition_key: "3:45",
      list_url: "https://nbatopshot.com/moment/m1",
    })
  })

  it("returns no_verifiable_moments when the wallet is indexed but holds nothing listable", async () => {
    state.user = { id: "u1" }
    install({
      saved_wallets: { data: [{ wallet_addr: "0xabc" }], error: null },
      "rpc:pick_verification_target": { data: [], error: null },
      wallet_moments_cache: [
        { data: [], error: null }, // relaxed candidate pick → empty
        { count: 5, error: null }, // wmc IS populated → not a cold wallet
      ],
    })

    const res = await POST(postReq({ wallet_addr: "0xABC" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.challenge).toBeNull()
    expect(body.unavailable).toBe(true)
    expect(body.reason).toBe("no_verifiable_moments")
  })
})

describe("GET /api/profile/verify-challenge — active challenge + enrichment", () => {
  it("returns the active challenge with a wmc-enriched target card", async () => {
    state.user = { id: "u1" }
    install({
      wallet_verification_challenges: {
        data: [
          {
            id: "ch1",
            wallet_addr: "0xabc",
            challenge_amount: 10,
            created_at: "2026-07-17T00:00:00Z",
            expires_at: "2999-01-01T00:00:00Z",
            resolved_at: null,
            resolved_via: null,
            matched_moment_id: null,
            target_moment_id: "m1",
            target_edition_key: "3:45",
            target_serial: 5,
            target_fmv: 0.5,
          },
        ],
        error: null,
      },
      wallet_moments_cache: {
        data: {
          moment_id: "m1",
          edition_key: "3:45",
          serial_number: 5,
          player_name: "Dame",
          set_name: "Base Set",
          image_url: "http://img",
          fmv_usd: 0.5,
        },
        error: null,
      },
    })

    const res = await GET(getReq("https://t/api/profile/verify-challenge?wallet_addr=0xABC"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.challenge.id).toBe("ch1")
    expect(body.challenge.expired).toBe(false)
    expect(body.target).toMatchObject({ moment_id: "m1", player_name: "Dame", image_url: "http://img" })
  })

  it("returns { challenge: null } when the wallet has no challenge row", async () => {
    state.user = { id: "u1" }
    install({ wallet_verification_challenges: { data: [], error: null } })
    const body = await (await GET(getReq("https://t/api/profile/verify-challenge?wallet_addr=0xABC"))).json()
    expect(body.challenge).toBeNull()
  })
})

describe("PATCH /api/profile/verify-challenge — resolver pass", () => {
  it("counts only this user's resolutions and returns their latest challenge", async () => {
    state.user = { id: "u1" }
    install({
      "rpc:resolve_wallet_verification_challenges": {
        data: [{ user_id: "u1" }, { user_id: "someone-else" }],
        error: null,
      },
      wallet_verification_challenges: {
        data: [
          {
            id: "ch1",
            wallet_addr: "0xabc",
            challenge_amount: 10,
            created_at: "2026-07-17T00:00:00Z",
            expires_at: "2999-01-01T00:00:00Z",
            resolved_at: null,
            resolved_via: null,
            matched_moment_id: null,
          },
        ],
        error: null,
      },
    })

    const body = await (await PATCH(postReq({ wallet_addr: "0xABC" }))).json()
    expect(body.resolvedThisPass).toBe(1) // filtered to user_id === u1
    expect(body.challenge.id).toBe("ch1")
    expect(body.challenge.expired).toBe(false)
  })
})

describe("POST /api/profile/verify-challenge — guard + fallback + error branches", () => {
  it("400s on an invalid JSON body", async () => {
    state.user = { id: "u1" }
    install({})
    const badReq = { url: "https://t/api/profile/verify-challenge", json: async () => { throw new Error("x") } } as never
    const res = await POST(badReq)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON body")
  })

  it("400s when wallet_addr is not a 0x address", async () => {
    state.user = { id: "u1" }
    install({})
    const res = await POST(postReq({ wallet_addr: "nope" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("wallet_addr")
  })

  it("cold wallet (no wmc rows) returns the indexing accept and kicks a backfill", async () => {
    state.user = { id: "u1" }
    install({
      saved_wallets: { data: [{ wallet_addr: "0xabc" }], error: null },
      "rpc:pick_verification_target": { data: [], error: null },
      wallet_moments_cache: [
        { data: [], error: null }, // relaxed candidate pick → empty
        { count: 0, error: null }, // wmc IS empty → cold wallet
      ],
    })
    const res = await POST(postReq({ wallet_addr: "0xABC" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.challenge).toBeNull()
    expect(body.reason).toBe("indexing")
    expect(body.message).toContain("indexing")
  })

  it("on-chain ownership gate rejecting every candidate returns the cache-stale indexing accept", async () => {
    state.user = { id: "u1" }
    state.ownedIds = ["other-moment"] // none of the candidates are held on chain now
    install({
      saved_wallets: { data: [{ wallet_addr: "0xabc" }], error: null },
      "rpc:pick_verification_target": {
        data: [{ moment_id: "m1", edition_key: "3:45", serial_number: 5, player_name: "Dame", set_name: "Base", image_url: "http://img", fmv_usd: 0.5 }],
        error: null,
      },
    })
    const res = await POST(postReq({ wallet_addr: "0xABC" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.reason).toBe("indexing")
    expect(body.message).toContain("out of date")
  })

  it("every candidate found-but-listed/locked live returns no_listable_target", async () => {
    state.user = { id: "u1" }
    state.ownedIds = ["m1"]
    state.listingState = { found: true, isLocked: false, forSale: true, price: 5 } // already listed
    install({
      saved_wallets: { data: [{ wallet_addr: "0xabc" }], error: null },
      "rpc:pick_verification_target": {
        data: [{ moment_id: "m1", edition_key: "3:45", serial_number: 5, player_name: "Dame", set_name: "Base", image_url: "http://img", fmv_usd: 0.5 }],
        error: null,
      },
    })
    const res = await POST(postReq({ wallet_addr: "0xABC" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.reason).toBe("no_listable_target")
  })

  // 2026-09-06: public-api.nbatopshot.com is decommissioned. Every candidate
  // check threw and the route told the collector their Moments "look locked or
  // already listed" — and pointed at "owner attestation", a feature that does
  // not exist. Pin the honest classification: our check is down, not their bag.
  it("every candidate check THROWING (dead listing host) is listing_check_unavailable, never a claim about the collector's Moments", async () => {
    state.user = { id: "u1" }
    state.ownedIds = ["m1", "m2"]
    state.listingThrows = true
    install({
      saved_wallets: { data: [{ wallet_addr: "0xabc" }], error: null },
      "rpc:pick_verification_target": {
        data: [
          { moment_id: "m1", edition_key: "3:45", serial_number: 5, player_name: "Dame", set_name: "Base", image_url: "http://img", fmv_usd: 0.5 },
          { moment_id: "m2", edition_key: "3:46", serial_number: 6, player_name: "Dame", set_name: "Base", image_url: "http://img", fmv_usd: 0.6 },
        ],
        error: null,
      },
    })
    const res = await POST(postReq({ wallet_addr: "0xABC" }))
    state.listingThrows = false
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.reason).toBe("listing_check_unavailable")
    expect(body.unavailable).toBe(true)
    expect(String(body.message)).not.toMatch(/locked|already listed|attestation/i)
    expect(String(body.message)).toMatch(/unavailable|offline/i)
  })

  it("a Flow read failure (getIDs throws) falls through to the GQL-only path and still mints", async () => {
    state.user = { id: "u1" }
    state.throwOnChain = true // fetchOwnedTopShotIds returns null → ownership gate skipped
    install({
      saved_wallets: { data: [{ wallet_addr: "0xabc" }], error: null },
      "rpc:pick_verification_target": {
        data: [{ moment_id: "m1", edition_key: "3:45", serial_number: 5, player_name: "Dame", set_name: "Base", image_url: "http://img", fmv_usd: 0.5 }],
        error: null,
      },
      wallet_verification_challenges: [
        { data: null, error: null }, // supersede
        {
          data: { id: "chX", wallet_addr: "0xabc", challenge_amount: 50.42, created_at: "2026-07-17T00:00:00Z", expires_at: "2999-01-01T00:00:00Z", resolved_at: null, resolved_via: null, matched_moment_id: null, target_moment_id: "m1" },
          error: null,
        },
      ],
    })
    const res = await POST(postReq({ wallet_addr: "0xABC" }))
    expect(res.status).toBe(200)
    expect((await res.json()).challenge.id).toBe("chX")
  })

  it("uses the relaxed wmc fallback when the strict picker is empty (null fmv → default amount)", async () => {
    state.user = { id: "u1" }
    state.ownedIds = ["m2"]
    install({
      saved_wallets: { data: [{ wallet_addr: "0xabc" }], error: null },
      "rpc:pick_verification_target": { data: [], error: null },
      wallet_moments_cache: {
        data: [{ moment_id: "m2", edition_key: "7:7", serial_number: 2, player_name: "P", set_name: "S", image_url: "http://i", fmv_usd: null }],
        error: null,
      },
      wallet_verification_challenges: [
        { data: null, error: null }, // supersede
        {
          data: { id: "chR", wallet_addr: "0xabc", challenge_amount: 10.42, created_at: "2026-07-17T00:00:00Z", expires_at: "2999-01-01T00:00:00Z", resolved_at: null, resolved_via: null, matched_moment_id: null, target_moment_id: "m2" },
          error: null,
        },
      ],
    })
    const res = await POST(postReq({ wallet_addr: "0xABC" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.challenge.id).toBe("chR")
    expect(body.target.moment_id).toBe("m2")
  })

  it("500s when the challenge insert errors", async () => {
    state.user = { id: "u1" }
    state.ownedIds = ["m1"]
    install({
      saved_wallets: { data: [{ wallet_addr: "0xabc" }], error: null },
      "rpc:pick_verification_target": {
        data: [{ moment_id: "m1", edition_key: "3:45", serial_number: 5, player_name: "Dame", set_name: "Base", image_url: "http://img", fmv_usd: 0.5 }],
        error: null,
      },
      wallet_verification_challenges: [
        { data: null, error: null }, // supersede
        { data: null, error: { message: "insert boom" } }, // insert fails
      ],
    })
    const res = await POST(postReq({ wallet_addr: "0xABC" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("insert boom")
  })
})

describe("GET /api/profile/verify-challenge — remaining branches", () => {
  it("400s when wallet_addr query param is missing/invalid", async () => {
    state.user = { id: "u1" }
    install({})
    const res = await GET(getReq("https://t/api/profile/verify-challenge"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("wallet_addr")
  })

  it("500s when the challenge read errors", async () => {
    state.user = { id: "u1" }
    install({ wallet_verification_challenges: { data: null, error: { message: "get boom" } } })
    const res = await GET(getReq("https://t/api/profile/verify-challenge?wallet_addr=0xABC"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("get boom")
  })

  it("marks an expired challenge and returns no target card", async () => {
    state.user = { id: "u1" }
    install({
      wallet_verification_challenges: {
        data: [{ id: "chE", wallet_addr: "0xabc", challenge_amount: 10, created_at: "2020-01-01T00:00:00Z", expires_at: "2020-01-01T01:00:00Z", resolved_at: null, resolved_via: null, matched_moment_id: null, target_moment_id: "m1", target_edition_key: "3:45", target_serial: 5, target_fmv: 0.5 }],
        error: null,
      },
    })
    const res = await GET(getReq("https://t/api/profile/verify-challenge?wallet_addr=0xABC"))
    const body = await res.json()
    expect(body.challenge.expired).toBe(true)
    expect(body.challenge.msRemaining).toBe(0)
    expect(body.target).toBeNull()
  })

  it("returns no target card once the challenge is resolved", async () => {
    state.user = { id: "u1" }
    install({
      wallet_verification_challenges: {
        data: [{ id: "chD", wallet_addr: "0xabc", challenge_amount: 10, created_at: "2026-07-17T00:00:00Z", expires_at: "2999-01-01T00:00:00Z", resolved_at: "2026-07-17T01:00:00Z", resolved_via: "listing_match", matched_moment_id: "m1", target_moment_id: "m1", target_edition_key: "3:45", target_serial: 5, target_fmv: 0.5 }],
        error: null,
      },
    })
    const res = await GET(getReq("https://t/api/profile/verify-challenge?wallet_addr=0xABC"))
    const body = await res.json()
    expect(body.challenge.expired).toBe(false)
    expect(body.target).toBeNull()
  })
})

describe("PATCH /api/profile/verify-challenge — remaining branches", () => {
  it("tolerates a bad JSON body and an unscoped (no wallet) fetch", async () => {
    state.user = { id: "u1" }
    install({
      "rpc:resolve_wallet_verification_challenges": { data: [], error: null },
      wallet_verification_challenges: {
        data: [{ id: "chP", wallet_addr: "0xabc", challenge_amount: 10, created_at: "2026-07-17T00:00:00Z", expires_at: "2999-01-01T00:00:00Z", resolved_at: null, resolved_via: null, matched_moment_id: null }],
        error: null,
      },
    })
    const badReq = { url: "https://t/api/profile/verify-challenge", json: async () => { throw new Error("x") } } as never
    const body = await (await PATCH(badReq)).json()
    expect(body.resolvedThisPass).toBe(0)
    expect(body.challenge.id).toBe("chP")
  })

  it("continues (logs) when the resolver RPC errors", async () => {
    state.user = { id: "u1" }
    install({
      "rpc:resolve_wallet_verification_challenges": { data: null, error: { message: "res boom" } },
      wallet_verification_challenges: {
        data: [{ id: "chP2", wallet_addr: "0xabc", challenge_amount: 10, created_at: "2026-07-17T00:00:00Z", expires_at: "2999-01-01T00:00:00Z", resolved_at: null, resolved_via: null, matched_moment_id: null }],
        error: null,
      },
    })
    const body = await (await PATCH(postReq({ wallet_addr: "0xABC" }))).json()
    expect(body.resolvedThisPass).toBe(0) // resolved not an array → 0
    expect(body.challenge.id).toBe("chP2")
  })

  it("500s when the challenge fetch errors", async () => {
    state.user = { id: "u1" }
    install({
      "rpc:resolve_wallet_verification_challenges": { data: [], error: null },
      wallet_verification_challenges: { data: null, error: { message: "row boom" } },
    })
    const res = await PATCH(postReq({ wallet_addr: "0xABC" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("row boom")
  })

  it("returns { challenge: null } when the user has no challenge row", async () => {
    state.user = { id: "u1" }
    install({
      "rpc:resolve_wallet_verification_challenges": { data: [], error: null },
      wallet_verification_challenges: { data: [], error: null },
    })
    const body = await (await PATCH(postReq({ wallet_addr: "0xABC" }))).json()
    expect(body.challenge).toBeNull()
    expect(body.resolvedThisPass).toBe(0)
  })
})

// ── 2026-09-03: a FAILED wmc count is not a cold wallet ─────────────────────────
//
// supabase-js returns the error, so a timed-out count arrived as `count: null`,
// fell into `!wmcCount`, fired a full Cadence wallet walk and told an already-
// indexed collector "we're indexing your collection".
describe("verify-challenge — wmc count read fails", () => {
  it("says the index could not be read (reason index_unavailable) and does NOT claim indexing", async () => {
    state.user = { id: "u1" }
    install({
      saved_wallets: { data: [{ wallet_addr: "0xabc" }], error: null },
      "rpc:pick_verification_target": { data: [], error: null },
      wallet_moments_cache: [
        { data: [], error: null }, // relaxed candidate pick → empty
        { count: null, error: { message: "canceling statement due to statement timeout" } }, // the count FAILED
      ],
    })
    const res = await POST(postReq({ wallet_addr: "0xABC" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.challenge).toBeNull()
    expect(body.reason).toBe("index_unavailable")
    expect(body.reason).not.toBe("indexing")
    expect(body.message).not.toContain("indexing")
  })
})
