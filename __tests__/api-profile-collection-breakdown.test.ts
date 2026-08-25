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
  savedWallets: { data: any[] | null; error: any }
  breakdown: Record<string, { data: any[] | null; error: any }>
  cols: { data: any[] | null; error: any }
  throwOnSavedWallets: boolean
} = {
  user: null,
  bio: { data: null, error: null },
  savedWallets: { data: [], error: null },
  breakdown: {},
  cols: { data: [], error: null },
  throwOnSavedWallets: false,
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
      if (name === "get_user_saved_wallets") {
        if (state.throwOnSavedWallets) throw new Error("rpc blew up")
        return state.savedWallets
      }
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
  state.throwOnSavedWallets = false
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

  // INVERTED, not deleted. This case used to assert
  // `meta.saved_wallets_unavailable === true` at HTTP 200 — i.e. it PINNED the
  // defect. `CollectionBreakdownCard` reads the response through `fetchJson`
  // and discriminates on `res.ok`, an HTTP-level test that a route which always
  // answers 200 can never fail, and nothing anywhere reads `meta`. So this
  // "handled" failure rendered "No collection data yet." beside 0 moments to a
  // collector who owns thousands. A passing test asserting a promise is what
  // holds that promise in place, and the promise here was the wrong one.
  it("does not answer 200 with an empty list when the wallet RPC errors", async () => {
    state.bio = { data: { user_id: "u1" }, error: null }
    state.savedWallets = { data: null, error: { message: "db", code: "500" } }
    const res = await GET(req("https://t/api/profile/collection-breakdown?ownerKey=trevor"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).collections).toBeUndefined()
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

  // INVERTED. The old title — "skips a wallet … and still returns the rest" —
  // states the PARTIAL-READ defect as if it were the contract: the surviving
  // wallets' moment_count and FMV total were published as though they were the
  // whole, understating the reader's OWN holdings with nothing marking it
  // partial. The canon allows "throw, or carry complete:false"; complete:false
  // is unavailable because the only consumer reads no meta.
  it("does not publish a partial total when one wallet's breakdown RPC errors", async () => {
    state.bio = { data: { user_id: "u1" }, error: null }
    state.savedWallets = { data: [{ wallet_addr: "0xa" }, { wallet_addr: "0xbad" }], error: null }
    state.breakdown = {
      "0xa": { data: [{ collection_id: "c1", collection_name: "TS", moment_count: 1, total_fmv: 5 }], error: null },
      "0xbad": { data: null, error: { message: "boom", code: "x" } },
    }
    const res = await GET(req("https://t/api/profile/collection-breakdown?ownerKey=trevor"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).collections).toBeUndefined()
  })

  it("still merges every wallet when they all succeed — positive control", async () => {
    // Without this, the case above is satisfiable by a route that errors on any
    // multi-wallet request at all, which would be a different defect.
    state.bio = { data: { user_id: "u1" }, error: null }
    state.savedWallets = { data: [{ wallet_addr: "0xa" }, { wallet_addr: "0xb" }], error: null }
    state.breakdown = {
      "0xa": { data: [{ collection_id: "c1", collection_name: "TS", moment_count: 1, total_fmv: 5 }], error: null },
      "0xb": { data: [{ collection_id: "c1", collection_name: "TS", moment_count: 2, total_fmv: 7 }], error: null },
    }
    const res = await GET(req("https://t/api/profile/collection-breakdown?ownerKey=trevor"))
    expect(res.status).toBe(200)
    const { collections } = await res.json()
    expect(collections).toHaveLength(1)
    expect(collections[0].moment_count).toBe(3)
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

  // INVERTED. `owner_not_found` is a claim that the collector does not exist;
  // publishing it out of a failed profile_bio read makes that claim from a
  // database timeout. The genuine-absence control is the case directly above.
  it("does not claim owner_not_found when the profile_bio lookup errors", async () => {
    state.bio = { data: null, error: { message: "bio read failed" } }
    const res = await GET(req("https://t/api/profile/collection-breakdown?ownerKey=trevor"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(JSON.stringify(await res.json())).not.toContain("owner_not_found")
  })

  // INVERTED. Same reason: a thrown downstream RPC is a read failure, and a
  // 200 with an empty list is how the card learns "this collector owns nothing".
  it("does not answer 200 with an empty list when a downstream RPC throws", async () => {
    state.bio = { data: { user_id: "u1" }, error: null }
    state.throwOnSavedWallets = true
    const res = await GET(req("https://t/api/profile/collection-breakdown?ownerKey=trevor"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).collections).toBeUndefined()
  })

  it("uses DEFAULT_COLOR for an unknown slug and for the 'unknown' collection_id bucket", async () => {
    state.bio = { data: { user_id: "u1" }, error: null }
    state.savedWallets = { data: [{ wallet_addr: "0xa" }], error: null }
    state.breakdown = {
      "0xa": {
        data: [
          // real id but a slug not in COLLECTION_COLOR -> DEFAULT_COLOR
          { collection_id: "c9", collection_name: "Mystery", moment_count: 4, total_fmv: 40 },
          // null collection_id -> "unknown" bucket, excluded from the slug lookup -> DEFAULT_COLOR
          { collection_id: null, collection_name: "Ghost", moment_count: 2, total_fmv: 20 },
        ],
        error: null,
      },
    }
    state.cols = { data: [{ id: "c9", slug: "some-unlisted-collection" }], error: null }
    const { collections } = await (
      await GET(req("https://t/api/profile/collection-breakdown?ownerKey=trevor"))
    ).json()
    expect(collections).toHaveLength(2)
    expect(collections.every((c: any) => c.color === "#6B7280")).toBe(true)
    expect(collections.find((c: any) => c.collection_id === "unknown")).toBeTruthy()
  })

  it("coerces a non-finite total_fmv to 0 and accepts a numeric-string fmv", async () => {
    state.bio = { data: { user_id: "u1" }, error: null }
    state.savedWallets = { data: [{ wallet_addr: "0xa" }], error: null }
    state.breakdown = {
      "0xa": {
        data: [
          { collection_id: "c1", collection_name: "TS", moment_count: 1, total_fmv: "abc" }, // NaN -> 0
          { collection_id: "c2", collection_name: "AD", moment_count: 1, total_fmv: "12.5" }, // string number
        ],
        error: null,
      },
    }
    state.cols = { data: [{ id: "c1", slug: "nba-top-shot" }, { id: "c2", slug: "nfl-all-day" }], error: null }
    const { collections } = await (
      await GET(req("https://t/api/profile/collection-breakdown?ownerKey=trevor"))
    ).json()
    const c1 = collections.find((c: any) => c.collection_id === "c1")
    const c2 = collections.find((c: any) => c.collection_id === "c2")
    expect(c1.total_fmv).toBe(0)
    expect(c2.total_fmv).toBe(12.5)
    // higher fmv sorts first
    expect(collections[0].collection_id).toBe("c2")
  })

  it("breaks a total_fmv tie by moment_count (secondary sort key)", async () => {
    state.bio = { data: { user_id: "u1" }, error: null }
    state.savedWallets = { data: [{ wallet_addr: "0xa" }], error: null }
    state.breakdown = {
      "0xa": {
        data: [
          { collection_id: "c1", collection_name: "TS", moment_count: 2, total_fmv: 100 },
          { collection_id: "c2", collection_name: "AD", moment_count: 9, total_fmv: 100 },
        ],
        error: null,
      },
    }
    state.cols = { data: [], error: null } // cols empty -> both DEFAULT_COLOR
    const { collections } = await (
      await GET(req("https://t/api/profile/collection-breakdown?ownerKey=trevor"))
    ).json()
    // equal fmv -> more moments first
    expect(collections[0].collection_id).toBe("c2")
    expect(collections[1].collection_id).toBe("c1")
  })
})
