import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/tier-breakdown. Deliberately NOT
// fail-closed with a 401 — it's a public collector-showcase read that returns
// a 200 empty shape ({tiers:[],total:0}) with a meta reason instead. Pins the
// unauthenticated fallback (meta.unauthenticated), the owner_not_found branch,
// the no_wallets branch, AND the aggregation core: per-address de-dupe (saved
// wallets come one-row-per-collection, so counting per row inflated tiers ~4x),
// 0x normalization, per-wallet RPC-error tolerance, coverage_zero, and the
// TIER_ORDER canonical sort with unknown tiers appended.

const state: {
  user: any
  single: any
  rpc: any // get_user_saved_wallets result
  tierCounts: Record<string, { data: any; error: any }>
  calls: Array<{ name: string; args: any }>
} = {
  user: null,
  single: { data: null, error: null },
  rpc: { data: [], error: null },
  tierCounts: {},
  calls: [],
}

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b, eq: () => b, ilike: () => b,
      maybeSingle: async () => state.single,
      then: (resolve: any) => resolve(state.single),
    }
    return b
  }
  const client: any = {
    from: () => build(),
    rpc: async (name: string, args: any) => {
      state.calls.push({ name, args })
      if (name === "get_wallet_tier_counts") return state.tierCounts[args?.p_wallet] ?? { data: {}, error: null }
      // get_user_saved_wallets (and any other) → the configured rpc result
      return state.rpc
    },
  }
  return { supabase: client, supabaseAdmin: client }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => state.user,
}))

import { GET } from "@/app/api/profile/tier-breakdown/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any
const wallet = (addr: string) => ({ wallet_addr: addr, username: null, collection_id: "c", collection_slug: "s", nickname: null, cached_fmv_usd: null })

beforeEach(() => {
  state.user = null
  state.single = { data: null, error: null }
  state.rpc = { data: [], error: null }
  state.tierCounts = {}
  state.calls = []
})

describe("GET /api/profile/tier-breakdown — resolution guards", () => {
  it("returns a 200 empty shape with meta.unauthenticated (no ownerKey, no session)", async () => {
    const res = await GET(req("https://t/api/profile/tier-breakdown"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ tiers: [], total: 0 })
    expect(body.meta.unauthenticated).toBe(true)
  })

  it("returns owner_not_found meta for an unknown ownerKey", async () => {
    state.single = { data: null, error: null }
    const body = await (await GET(req("https://t/api/profile/tier-breakdown?ownerKey=ghost"))).json()
    expect(body.meta.owner_not_found).toBe(true)
  })

  it("returns saved_wallets_unavailable when the SECDEF helper errors", async () => {
    state.single = { data: { user_id: "u1" }, error: null }
    state.rpc = { data: null, error: { message: "rls", code: "42501" } }
    const body = await (await GET(req("https://t/api/profile/tier-breakdown?ownerKey=trevor"))).json()
    expect(body.meta.saved_wallets_unavailable).toBe(true)
  })

  it("returns no_wallets meta when the resolved user has no saved wallets", async () => {
    state.single = { data: { user_id: "u1" }, error: null }
    state.rpc = { data: [], error: null }
    const body = await (await GET(req("https://t/api/profile/tier-breakdown?ownerKey=trevor"))).json()
    expect(body.meta.no_wallets).toBe(true)
  })
})

describe("GET /api/profile/tier-breakdown — aggregation core", () => {
  beforeEach(() => {
    state.single = { data: { user_id: "u1" }, error: null }
  })

  it("de-dupes repeated addresses so per-collection rows don't inflate tiers", async () => {
    state.rpc = { data: [wallet("0xaaa"), wallet("0xaaa"), wallet("0xaaa")], error: null }
    state.tierCounts["0xaaa"] = { data: { Common: 2, Rare: 1 }, error: null }
    const body = await (await GET(req("https://t/api/profile/tier-breakdown?ownerKey=me"))).json()
    expect(body.total).toBe(3) // counted ONCE, not 3×
    expect(body.tiers).toEqual([{ tier: "Common", count: 2 }, { tier: "Rare", count: 1 }])
    expect(state.calls.filter((c) => c.name === "get_wallet_tier_counts")).toHaveLength(1)
  })

  it("aggregates across distinct wallets, known tiers in canonical order then unknowns", async () => {
    state.rpc = { data: [wallet("0xaaa"), wallet("0xbbb")], error: null }
    state.tierCounts["0xaaa"] = { data: { Common: 2, Rare: 1 }, error: null }
    state.tierCounts["0xbbb"] = { data: { Common: 3, Mythic: 4 }, error: null } // Mythic ∉ TIER_ORDER
    const body = await (await GET(req("https://t/api/profile/tier-breakdown?ownerKey=me"))).json()
    expect(body.total).toBe(10)
    expect(body.tiers).toEqual([
      { tier: "Common", count: 5 },
      { tier: "Rare", count: 1 },
      { tier: "Mythic", count: 4 },
    ])
  })

  it("normalizes bare addresses to 0x and skips empty ones", async () => {
    state.rpc = { data: [wallet("bbb"), wallet(""), wallet("0x")], error: null }
    state.tierCounts["0xbbb"] = { data: { Legendary: 1 }, error: null }
    const body = await (await GET(req("https://t/api/profile/tier-breakdown?ownerKey=me"))).json()
    expect(body.tiers).toEqual([{ tier: "Legendary", count: 1 }])
    expect(state.calls.filter((c) => c.name === "get_wallet_tier_counts").map((c) => c.args.p_wallet)).toEqual(["0xbbb"])
  })

  it("tolerates a per-wallet RPC error and still aggregates the rest", async () => {
    state.rpc = { data: [wallet("0xaaa"), wallet("0xbbb")], error: null }
    state.tierCounts["0xaaa"] = { data: null, error: { message: "row fail", code: "XX" } }
    state.tierCounts["0xbbb"] = { data: { Ultimate: 2 }, error: null }
    const body = await (await GET(req("https://t/api/profile/tier-breakdown?ownerKey=me"))).json()
    expect(body.tiers).toEqual([{ tier: "Ultimate", count: 2 }])
    expect(body.total).toBe(2)
  })

  it("all wallets zero/errored → coverage_zero with attempt counts", async () => {
    state.rpc = { data: [wallet("0xaaa"), wallet("0xbbb")], error: null }
    state.tierCounts["0xaaa"] = { data: {}, error: null }
    state.tierCounts["0xbbb"] = { data: null, error: { message: "e", code: "X" } }
    const body = await (await GET(req("https://t/api/profile/tier-breakdown?ownerKey=me"))).json()
    expect(body.meta.coverage_zero).toBe(true)
    expect(body.meta.wallets_attempted).toBe(2)
    expect(body.meta.wallets_with_rpc_error).toBe(1)
  })
})
