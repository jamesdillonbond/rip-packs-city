import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/top-movers. Like tier-breakdown this
// is a public collector-showcase read: it never 401s, returning a 200 empty
// shape ({gainers:[],losers:[]}) with a meta reason. Pins the unauthenticated
// fallback, the owner_not_found branch, and the no_wallets branch.

// `rpcByFn` was added so the SAVED-WALLETS rpc and the PER-WALLET movers rpc
// can fail independently. With one shared `rpc` slot the per-wallet partial-read
// case below cannot be expressed at all — and a mock that cannot express the
// failure cannot pin it.
const state: { user: any; single: any; rpc: any; rpcByFn: Record<string, any> } = {
  user: null,
  single: { data: null, error: null },
  rpc: { data: [], error: null },
  rpcByFn: {},
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
    rpc: async (fn: string) => state.rpcByFn[fn] ?? state.rpc,
  }
  return { supabase: client, supabaseAdmin: client }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => state.user,
}))

import { GET } from "@/app/api/profile/top-movers/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.user = null
  state.single = { data: null, error: null }
  state.rpc = { data: [], error: null }
  state.rpcByFn = {}
})

describe("GET /api/profile/top-movers", () => {
  it("returns a 200 empty shape with meta.unauthenticated (no ownerKey, no session)", async () => {
    const res = await GET(req("https://t/api/profile/top-movers"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ gainers: [], losers: [] })
    expect(body.meta.unauthenticated).toBe(true)
  })

  it("returns owner_not_found meta for an unknown ownerKey", async () => {
    const body = await (await GET(req("https://t/api/profile/top-movers?ownerKey=ghost"))).json()
    expect(body.meta.owner_not_found).toBe(true)
  })

  it("returns no_wallets meta when the resolved user has no saved wallets", async () => {
    state.single = { data: { user_id: "u1" }, error: null }
    state.rpc = { data: [], error: null }
    const body = await (await GET(req("https://t/api/profile/top-movers?ownerKey=trevor"))).json()
    expect(body.meta.no_wallets).toBe(true)
  })

  // HONESTY CANON. This route answered 200 with an empty shape for every
  // failure, and `TopMoversCard` discriminates on `res.ok` — an HTTP test a
  // always-200 route can never fail — so its (correct) failure branch was
  // unreachable and the card fell through to copy that does not say "nothing
  // moved" but explains the blank as PIPELINE PROGRESS and tells the reader to
  // wait days. The three cases above are the genuine-empty positive controls.
  it("does not claim owner_not_found when the profile_bio read errored", async () => {
    state.single = { data: null, error: { message: "canceling statement due to statement timeout" } }
    const res = await GET(req("https://t/api/profile/top-movers?ownerKey=trevor"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain("owner_not_found")
    expect(JSON.stringify(body)).not.toContain("canceling statement")
  })

  it("does not answer 200 with an empty movers shape when the saved-wallets RPC errors", async () => {
    state.single = { data: { user_id: "u1" }, error: null }
    state.rpcByFn.get_user_saved_wallets = { data: null, error: { message: "rls", code: "42501" } }
    const res = await GET(req("https://t/api/profile/top-movers?ownerKey=trevor"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).gainers).toBeUndefined()
  })

  it("does not publish a partial movers list when one wallet's RPC errors", async () => {
    state.single = { data: { user_id: "u1" }, error: null }
    state.rpcByFn.get_user_saved_wallets = { data: [{ wallet_addr: "0xaaa" }], error: null }
    state.rpcByFn.get_top_movers = { data: null, error: { message: "boom", code: "X" } }
    const res = await GET(req("https://t/api/profile/top-movers?ownerKey=trevor"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).gainers).toBeUndefined()
  })

  it("returns the movers when every wallet succeeds — positive control", async () => {
    state.single = { data: { user_id: "u1" }, error: null }
    state.rpcByFn.get_user_saved_wallets = { data: [{ wallet_addr: "0xaaa" }], error: null }
    state.rpcByFn.get_top_movers = {
      data: { gainers: [{ edition_id: "e1", delta: 5 }], losers: [] },
      error: null,
    }
    const res = await GET(req("https://t/api/profile/top-movers?ownerKey=trevor"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.gainers).toHaveLength(1)
  })
})
