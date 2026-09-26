import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/wallet/pack-lifecycle. requireUser() runs
// first → fail-closed 401 when unauthenticated, before the wallet/packNftId
// guard. Success path: a signed-in user whose requested wallet is a verified
// saved_wallet reaches get_pack_lifecycle — ownership chain resolves a match
// and the RPC fixture is returned.

const state: { user: any; owned: any; rpc: any; rpcByFn: Record<string, any>; calls: string[] } = {
  user: null,
  owned: { data: [], error: null },
  rpc: { data: null, error: null },
  rpcByFn: {},
  calls: [],
}

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b, eq: () => b, not: () => b, limit: () => b,
    then: (resolve: any) => resolve(state.owned),
  }
  return { supabaseAdmin: { from: () => b, rpc: async (fn: string) => { state.calls.push(fn); return state.rpcByFn[fn] ?? state.rpc } } }
})
vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user)
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      })
    return state.user
  },
}))

import { GET } from "@/app/api/wallet/pack-lifecycle/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => {
  state.user = null
  state.owned = { data: [], error: null }
  state.rpc = { data: null, error: null }
  state.rpcByFn = {}
  state.calls = []
})

describe("GET /api/wallet/pack-lifecycle", () => {
  it("401s when unauthenticated (requireUser fail-closed)", async () => {
    const res = await GET(req("https://t/api/wallet/pack-lifecycle?wallet=0xabc&packNftId=1"))
    expect(res.status).toBe(401)
  })

  it("200s and returns the lifecycle payload for a verified wallet", async () => {
    state.user = { id: "u1" }
    state.owned = { data: [{ wallet_addr: "0xabc" }], error: null }
    state.rpc = { data: { pack_nft_id: "1", timeline: [{ event: "purchase" }] }, error: null }
    const res = await GET(req("https://t/api/wallet/pack-lifecycle?wallet=0xabc&packNftId=1"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.pack_nft_id).toBe("1")
    expect(body.timeline[0].event).toBe("purchase")
    expect(res.headers.get("Cache-Control")).toContain("no-store")
  })

  it("400s when wallet or packNftId is missing (authed)", async () => {
    state.user = { id: "u1" }
    const res = await GET(req("https://t/api/wallet/pack-lifecycle?wallet=0xabc"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("required")
  })

  it("500s when the saved_wallets lookup errors", async () => {
    state.user = { id: "u1" }
    state.owned = { data: null, error: { message: "db down" } }
    const res = await GET(req("https://t/api/wallet/pack-lifecycle?wallet=0xabc&packNftId=1"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("db down")
  })

  it("403s when the wallet is not SAVED on this account (verification no longer gates — 09-06, #59)", async () => {
    state.user = { id: "u1" }
    state.owned = { data: [], error: null } // no ownership match
    const res = await GET(req("https://t/api/wallet/pack-lifecycle?wallet=0xabc&packNftId=1"))
    expect(res.status).toBe(403)
    const err = (await res.json()).error as string
    expect(err).toContain("not saved")
    expect(err).not.toContain("verified")
  })

  it("500s when get_pack_lifecycle returns an error", async () => {
    state.user = { id: "u1" }
    state.owned = { data: [{ wallet_addr: "0xabc" }], error: null }
    state.rpc = { data: null, error: { message: "rpc boom" } }
    const res = await GET(req("https://t/api/wallet/pack-lifecycle?wallet=0xabc&packNftId=1"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("rpc boom")
  })

  it("normalizes the wallet to lowercase before the ownership check", async () => {
    state.user = { id: "u1" }
    state.owned = { data: [{ wallet_addr: "0xabc" }], error: null }
    state.rpc = { data: {}, error: null }
    const res = await GET(req("https://t/api/wallet/pack-lifecycle?wallet=0xABC&packNftId=1"))
    expect(res.status).toBe(200)
  })

  // ── 2026-09-26: the pulls come from what the pack REALLY yielded ──
  const authed = () => {
    state.user = { id: "u1" }
    state.owned = { data: [{ wallet_addr: "0xabc" }], error: null }
  }
  const junk = Array.from({ length: 95 }, (_, i) => ({ nft_id: String(i) }))

  it("replaces the acquisition-linkage pull list with the wallet's own pull list", async () => {
    authed()
    state.rpcByFn.get_pack_lifecycle = { data: { pack_nft_id: "1", rip: { moments_pulled: 3 }, pulls: junk }, error: null }
    state.rpcByFn.get_wallet_pack_pulls = { data: { source: "dapper_pulls", pulls: [{ nft_id: "a" }, { nft_id: "b" }, { nft_id: "c" }], pulls_total: 3, pulls_identified: 3, pulls_priced: 2 }, error: null }
    const body = await (await GET(req("https://t/api/wallet/pack-lifecycle?wallet=0xabc&packNftId=1&collection=nba_top_shot"))).json()
    expect(body.pulls).toHaveLength(3)
    expect(body.pulls_source).toBe("dapper_pulls")
    expect(body.pulls_priced).toBe(2)
  })

  it("never shows a pull list that is not the size of the pack — 95 'pulls' for a 3-moment pack become none", async () => {
    authed()
    state.rpcByFn.get_pack_lifecycle = { data: { pack_nft_id: "1", rip: { moments_pulled: 3 }, pulls: junk }, error: null }
    state.rpcByFn.get_wallet_pack_pulls = { data: { source: null, pulls: [] }, error: null }
    const body = await (await GET(req("https://t/api/wallet/pack-lifecycle?wallet=0xabc&packNftId=1&collection=nba_top_shot"))).json()
    expect(body.pulls).toEqual([])
    expect(body.pulls_source).toBeNull()
  })

  it("keeps a lifecycle pull list that IS the size of the pack", async () => {
    authed()
    state.rpcByFn.get_pack_lifecycle = { data: { pack_nft_id: "1", rip: { moments_pulled: 2 }, pulls: [{ nft_id: "x" }, { nft_id: "y" }] }, error: null }
    const body = await (await GET(req("https://t/api/wallet/pack-lifecycle?wallet=0xabc&packNftId=1"))).json()
    expect(body.pulls).toHaveLength(2)
    expect(body.pulls_source).toBe("rip_record")
  })

  it("a reconstructed rip (burst:) skips the pack lifecycle and lists its own moments", async () => {
    authed()
    state.rpcByFn.get_wallet_pack_pulls = { data: { source: "delivery_burst", pulls: [{ nft_id: "5" }], pulls_total: 1, pulls_identified: 1, pulls_priced: 1 }, error: null }
    const body = await (await GET(req("https://t/api/wallet/pack-lifecycle?wallet=0xabc&packNftId=burst%3A5&collection=nba_top_shot"))).json()
    expect(state.calls).not.toContain("get_pack_lifecycle")
    expect(body.pulls_source).toBe("delivery_burst")
    expect(body.pulls).toHaveLength(1)
  })

  it("a failed pull read errors — it never falls back to the linkage it replaces", async () => {
    authed()
    state.rpcByFn.get_pack_lifecycle = { data: { pack_nft_id: "1", rip: { moments_pulled: 95 }, pulls: junk }, error: null }
    state.rpcByFn.get_wallet_pack_pulls = { data: null, error: { message: "boom" } }
    const res = await GET(req("https://t/api/wallet/pack-lifecycle?wallet=0xabc&packNftId=1&collection=nba_top_shot"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(JSON.stringify(await res.json())).not.toContain("\"pulls\"")
  })
})
