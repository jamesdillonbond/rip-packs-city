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

  // INVERTED, not deleted. This PINNED the defect: an empty shape at HTTP 200
  // with a meta hint nothing reads. TierBreakdownCard renders total === 0 as
  // "Load a saved wallet to see your tier mix." — a claim about the reader's own
  // account of the ACTIONABLE kind, telling a collector to redo work already
  // done. The no_wallets case directly below is the genuine-empty control.
  it("does not answer 200 with an empty tier shape when the SECDEF helper errors", async () => {
    state.single = { data: { user_id: "u1" }, error: null }
    state.rpc = { data: null, error: { message: "rls", code: "42501" } }
    const res = await GET(req("https://t/api/profile/tier-breakdown?ownerKey=trevor"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.total).toBeUndefined()
    expect(body.tiers).toBeUndefined()
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

  // INVERTED. The old title states the PARTIAL-READ defect as the contract:
  // "tolerates … and still aggregates the rest" published one wallet's tier mix
  // as the collector's whole tier mix. The title is the tell — a name carrying a
  // transformation is a promise, and this one promised the wrong thing.
  it("does not publish a partial tier mix when one wallet's RPC errors", async () => {
    state.rpc = { data: [wallet("0xaaa"), wallet("0xbbb")], error: null }
    state.tierCounts["0xaaa"] = { data: null, error: { message: "row fail", code: "XX" } }
    state.tierCounts["0xbbb"] = { data: { Ultimate: 2 }, error: null }
    const res = await GET(req("https://t/api/profile/tier-breakdown?ownerKey=me"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).total).toBeUndefined()
  })

  it("still aggregates across every wallet when they all succeed — positive control", async () => {
    state.rpc = { data: [wallet("0xaaa"), wallet("0xbbb")], error: null }
    state.tierCounts["0xaaa"] = { data: { Ultimate: 1 }, error: null }
    state.tierCounts["0xbbb"] = { data: { Ultimate: 2 }, error: null }
    const res = await GET(req("https://t/api/profile/tier-breakdown?ownerKey=me"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.total).toBe(3)
  })

  // NARROWED, deliberately. coverage_zero is a REAL state and keeps its honest
  // 200 — but it now means what its name says: every wallet was READ and every
  // one came back empty. The old fixture mixed an errored wallet into it, which
  // is why `wallets_with_rpc_error: 1` could appear beside a published total.
  // That combination is no longer reachable, so the assertion on it is 0 rather
  // than removed — the field is part of the published shape.
  it("every wallet read OK and empty → coverage_zero with attempt counts", async () => {
    state.rpc = { data: [wallet("0xaaa"), wallet("0xbbb")], error: null }
    state.tierCounts["0xaaa"] = { data: {}, error: null }
    state.tierCounts["0xbbb"] = { data: {}, error: null }
    const res = await GET(req("https://t/api/profile/tier-breakdown?ownerKey=me"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.coverage_zero).toBe(true)
    expect(body.meta.wallets_attempted).toBe(2)
    expect(body.meta.wallets_with_rpc_error).toBe(0)
  })

  it("a wallet that ERRORED can no longer be laundered into coverage_zero", async () => {
    state.rpc = { data: [wallet("0xaaa"), wallet("0xbbb")], error: null }
    state.tierCounts["0xaaa"] = { data: {}, error: null }
    state.tierCounts["0xbbb"] = { data: null, error: { message: "e", code: "X" } }
    const res = await GET(req("https://t/api/profile/tier-breakdown?ownerKey=me"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(JSON.stringify(await res.json())).not.toContain("coverage_zero")
  })
})
