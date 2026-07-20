import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/collection-breakdown.
// The public ?ownerKey path resolves username → user_id via profile_bio; the
// no-ownerKey path falls back to getCurrentUser(). Both failure modes return
// 200 with { collections: [] } + a meta hint (fail-soft, not 401). Pin: the
// unauthenticated no-ownerKey path, the owner-not-found path, and an authed
// happy path where get_user_saved_wallets returns [] → meta.no_wallets.

const state: {
  user: any
  bio: { data: any; error: any }
  savedWallets: { data: any; error: any }
  breakdown: Record<string, { data: any; error: any }>
  cols: { data: any; error: any }
} = {
  user: null,
  bio: { data: null, error: null },
  savedWallets: { data: [], error: null },
  breakdown: {},
  cols: { data: [], error: null },
}

function chain(getResult: () => any): any {
  const b: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (res: any, rej: any) => Promise.resolve(getResult()).then(res, rej)
        return () => b
      },
    }
  )
  return b
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    // profile_bio (username resolve) → state.bio; collections (slug lookup) → state.cols
    from: (table: string) => chain(() => (table === "collections" ? state.cols : state.bio)),
    rpc: async (name: string, args: any) => {
      if (name === "get_user_saved_wallets") return state.savedWallets
      if (name === "get_collection_breakdown") return state.breakdown[args?.p_wallet] ?? { data: [], error: null }
      return { data: [], error: null }
    },
  },
}))

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => state.user,
}))

import { GET } from "@/app/api/profile/collection-breakdown/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.user = null
  state.bio = { data: null, error: null }
  state.savedWallets = { data: [], error: null }
  state.breakdown = {}
  state.cols = { data: [], error: null }
})

describe("GET /api/profile/collection-breakdown", () => {
  it("returns { collections: [], meta.unauthenticated } with no ownerKey and no session", async () => {
    state.user = null
    const res = await GET(req("https://t/api/profile/collection-breakdown"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.collections).toEqual([])
    expect(body.meta.unauthenticated).toBe(true)
  })

  it("returns meta.owner_not_found for an unresolvable ownerKey", async () => {
    state.bio = { data: null, error: null }
    const res = await GET(req("https://t/api/profile/collection-breakdown?ownerKey=ghost"))
    expect(res.status).toBe(200)
    expect((await res.json()).meta.owner_not_found).toBe(true)
  })

  it("returns meta.no_wallets when the resolved user has no saved wallets", async () => {
    state.bio = { data: { user_id: "u1" }, error: null }
    state.savedWallets = { data: [], error: null }
    const res = await GET(req("https://t/api/profile/collection-breakdown?ownerKey=trevor"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.collections).toEqual([])
    expect(body.meta.no_wallets).toBe(true)
  })

  it("returns meta.saved_wallets_unavailable when the wallet RPC errors", async () => {
    state.bio = { data: { user_id: "u1" }, error: null }
    state.savedWallets = { data: null, error: { message: "db", code: "500" } }
    const res = await GET(req("https://t/api/profile/collection-breakdown?ownerKey=trevor"))
    expect((await res.json()).meta.saved_wallets_unavailable).toBe(true)
  })

  it("merges per-wallet breakdowns (deduped per distinct address), color-codes, and sorts by fmv", async () => {
    state.bio = { data: { user_id: "u1" }, error: null }
    // wallet "0xa" appears twice (two collection rows), "0xb" once → 2 distinct addrs
    state.savedWallets = {
      data: [
        { wallet_addr: "0xa" },
        { wallet_addr: "0xa" },
        { wallet_addr: "0xb" },
      ],
      error: null,
    }
    state.breakdown = {
      "0xa": {
        data: [
          { collection_id: "c1", collection_name: "Top Shot", moment_count: 3, total_fmv: 100 },
          { collection_id: "c2", collection_name: "All Day", moment_count: 1, total_fmv: 10 },
        ],
        error: null,
      },
      "0xb": {
        data: [{ collection_id: "c1", collection_name: "Top Shot", moment_count: 2, total_fmv: 50 }],
        error: null,
      },
    }
    state.cols = { data: [{ id: "c1", slug: "nba-top-shot" }, { id: "c2", slug: "nfl-all-day" }], error: null }

    const res = await GET(req("https://t/api/profile/collection-breakdown?ownerKey=trevor"))
    expect(res.status).toBe(200)
    const { collections } = await res.json()
    // c1 merged across both wallets: 3+2 moments, 100+50 fmv; c2 only from 0xa
    expect(collections).toHaveLength(2)
    expect(collections[0]).toMatchObject({ collection_id: "c1", moment_count: 5, total_fmv: 150 }) // highest fmv first
    expect(collections[1]).toMatchObject({ collection_id: "c2", moment_count: 1, total_fmv: 10 })
    expect(typeof collections[0].color).toBe("string")
  })

  it("skips a wallet whose breakdown RPC errors and still returns the rest", async () => {
    state.bio = { data: { user_id: "u1" }, error: null }
    state.savedWallets = { data: [{ wallet_addr: "0xa" }, { wallet_addr: "0xbad" }], error: null }
    state.breakdown = {
      "0xa": { data: [{ collection_id: "c1", collection_name: "TS", moment_count: 1, total_fmv: 5 }], error: null },
      "0xbad": { data: null, error: { message: "boom", code: "x" } },
    }
    const res = await GET(req("https://t/api/profile/collection-breakdown?ownerKey=trevor"))
    const { collections } = await res.json()
    expect(collections).toHaveLength(1)
    expect(collections[0].collection_id).toBe("c1")
  })

  it("falls back to getCurrentUser when no ownerKey is supplied", async () => {
    state.user = { id: "u9" }
    state.savedWallets = { data: [{ wallet_addr: "0xa" }], error: null }
    state.breakdown = { "0xa": { data: [{ collection_id: "c1", collection_name: "TS", moment_count: 1, total_fmv: 9 }], error: null } }
    state.cols = { data: [{ id: "c1", slug: "nba-top-shot" }], error: null }
    const res = await GET(req("https://t/api/profile/collection-breakdown"))
    expect(res.status).toBe(200)
    expect((await res.json()).collections[0].collection_id).toBe("c1")
  })
})
