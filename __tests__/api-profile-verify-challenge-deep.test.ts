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
  listingState: { found: true, isLocked: false, forSale: false, price: null as number | null },
}))

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
  fetchMomentListingState: async () => state.listingState,
  topShotMomentUrl: (id: string) => `https://nbatopshot.com/moment/${id}`,
}))
vi.mock("@/lib/chains/flow/wallet-backfill-helpers", () => ({
  fetchOnChainIds: async () => state.ownedIds,
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
