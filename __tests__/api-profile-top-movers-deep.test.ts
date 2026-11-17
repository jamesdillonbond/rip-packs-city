import { describe, it, expect, beforeEach, vi } from "vitest"

// Deep drive of GET /api/profile/top-movers (the sibling only spot-checks). Merges
// get_top_movers across a user's saved wallets (resolved by ownerKey→profile_bio or
// the current session), deduping by edition_id and taking the top 5 gainers/losers.
// Legs pinned: owner_not_found, unauthenticated, saved_wallets_unavailable,
// no_wallets, the per-wallet dedup + get_top_movers error-continue, the edition
// dedup + sort + slice, and the unexpected_error catch.

const st = vi.hoisted(() => ({
  bio: { data: null as any, error: null as any },
  user: { id: "u1" } as any,
  wallets: { data: [] as any[] | null, error: null as any },
  moversByAddr: {} as Record<string, any>,
  moversThrow: false,
}))
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => st.user }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from() {
      const b: any = { select: () => b, ilike: () => b, maybeSingle: async () => st.bio }
      return b
    },
    rpc: async (name: string, params: any) => {
      if (name === "get_user_saved_wallets") return st.wallets
      if (name === "get_top_movers") {
        if (st.moversThrow) throw new Error("movers boom")
        return st.moversByAddr[params.p_wallet] ?? { data: { gainers: [], losers: [] }, error: null }
      }
      return { data: null, error: null }
    },
  },
}))

import { GET } from "@/app/api/profile/top-movers/route"

const get = (qs = "") => ({ nextUrl: new URL(`https://t/api/profile/top-movers${qs}`) }) as any
const mover = (id: string, delta: number) => ({ edition_id: id, player_name: "P", set_name: "S", current_fmv: 10, past_fmv: 5, delta, pct_change: 100 })

beforeEach(() => {
  st.bio = { data: { user_id: "resolved-user" }, error: null }
  st.user = { id: "u1" }
  st.wallets = { data: [], error: null }
  st.moversByAddr = {}
  st.moversThrow = false
})

describe("GET /api/profile/top-movers", () => {
  it("ownerKey that resolves to no user → owner_not_found empty shape", async () => {
    st.bio = { data: null, error: null }
    const body = await (await GET(get("?ownerKey=ghost"))).json()
    expect(body).toMatchObject({ gainers: [], losers: [], meta: { owner_not_found: true } })
  })
  it("no ownerKey + no session → unauthenticated empty shape", async () => {
    st.user = null
    const body = await (await GET(get())).json()
    expect(body.meta.unauthenticated).toBe(true)
  })
  // INVERTED, not deleted. This PINNED the defect: a read failure answered 200
  // with an empty movers shape and a meta hint nothing reads. `TopMoversCard`
  // discriminates on `res.ok` — an HTTP test an always-200 route can never fail
  // — so its correct failure branch was unreachable and the card fell through to
  // copy that explains the blank as PIPELINE PROGRESS and tells the reader to
  // wait days. The no_wallets case directly below is the genuine-empty control.
  it("saved-wallets rpc error does NOT answer 200 with an empty movers shape", async () => {
    st.wallets = { data: null, error: { message: "rpc down" } }
    const res = await GET(get())
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).gainers).toBeUndefined()
  })
  it("no wallets → no_wallets", async () => {
    st.wallets = { data: [], error: null }
    const body = await (await GET(get())).json()
    expect(body.meta.no_wallets).toBe(true)
  })
  it("merges movers across wallets, dedups by edition, sorts, and slices to 5", async () => {
    st.wallets = { data: [{ wallet_addr: "0xa" }, { wallet_addr: "0xa" }, { wallet_addr: "0xb" }], error: null } // 0xa deduped
    st.moversByAddr = {
      "0xa": { data: { gainers: [mover("e1", 100), mover("e2", 50)], losers: [mover("e3", -30)] }, error: null },
      "0xb": { data: { gainers: [mover("e1", 100), mover("e4", 200)], losers: [mover("e5", -80)] }, error: null }, // e1 dup
    }
    const body = await (await GET(get())).json()
    // gainers deduped (e1,e2,e4) sorted by delta desc → e4(200), e1(100), e2(50)
    expect(body.gainers.map((g: any) => g.edition_id)).toEqual(["e4", "e1", "e2"])
    // losers sorted by delta asc → e5(-80), e3(-30)
    expect(body.losers.map((l: any) => l.edition_id)).toEqual(["e5", "e3"])
  })
  // INVERTED. The old title states the PARTIAL-READ defect as the contract —
  // "is skipped (continue), others still merge" — i.e. one wallet's movers were
  // published as the collector's whole movers list. The merge/dedupe case
  // directly above is the all-wallets-succeed positive control.
  it("a per-wallet get_top_movers error does NOT yield a partial movers list", async () => {
    st.wallets = { data: [{ wallet_addr: "0xa" }, { wallet_addr: "0xb" }], error: null }
    st.moversByAddr = {
      "0xa": { data: null, error: { message: "wallet a failed" } },
      "0xb": { data: { gainers: [mover("e9", 5)], losers: [] }, error: null },
    }
    const res = await GET(get())
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).gainers).toBeUndefined()
  })
  it("normalizes a bare (non-0x) wallet address before querying", async () => {
    st.wallets = { data: [{ wallet_addr: "abc0000000000001" }], error: null }
    st.moversByAddr = { "0xabc0000000000001": { data: { gainers: [mover("e1", 1)], losers: [] }, error: null } }
    const body = await (await GET(get())).json()
    expect(body.gainers).toHaveLength(1)
  })
  // INVERTED, same reason: an unexpected throw is a read failure, and a 200
  // empty shape is how the card learns "nothing moved for this collector".
  it("an unexpected throw does NOT answer 200 with an empty shape", async () => {
    st.wallets = { data: [{ wallet_addr: "0xa" }], error: null }
    st.moversThrow = true
    const res = await GET(get())
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).gainers).toBeUndefined()
  })
})
