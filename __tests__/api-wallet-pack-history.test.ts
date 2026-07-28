import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/wallet/pack-history. requireUser() runs
// first and throws a 401 Response when unauthenticated → fail-closed 401 before
// the wallet guard. Success path: a signed-in user whose requested wallet is a
// verified saved_wallet reaches get_wallet_pack_history. The 2026-07-28 Gap-C+
// pass adds the previously-dark branches: the wallet/collection/status param
// 400s, slug normalization (hyphen↔DB form), the limit clamp, the verify-lookup
// 500, and the RPC error + thrown-RPC 500 legs.

const state: { user: any; owned: any; rpc: any; rpcParams: any; rpcThrows: boolean } = {
  user: null,
  owned: { data: [], error: null },
  rpc: { data: null, error: null },
  rpcParams: null,
  rpcThrows: false,
}

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b, eq: () => b, not: () => b, limit: () => b,
    then: (resolve: any) => resolve(state.owned),
  }
  return {
    supabaseAdmin: {
      from: () => b,
      rpc: async (_fn: string, params: any) => {
        state.rpcParams = params
        if (state.rpcThrows) throw new Error("rpc exploded")
        return state.rpc
      },
    },
  }
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

import { GET } from "@/app/api/wallet/pack-history/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => {
  state.user = null
  state.owned = { data: [], error: null }
  state.rpc = { data: null, error: null }
  state.rpcParams = null
  state.rpcThrows = false
})

const verified = () => {
  state.user = { id: "u1" }
  state.owned = { data: [{ wallet_addr: "0xabc" }], error: null }
  state.rpc = { data: {}, error: null }
}

describe("GET /api/wallet/pack-history", () => {
  it("401s when unauthenticated (requireUser fail-closed)", async () => {
    expect((await GET(req("https://t/api/wallet/pack-history?wallet=0xabc"))).status).toBe(401)
  })

  it("400s without a wallet param", async () => {
    state.user = { id: "u1" }
    const res = await GET(req("https://t/api/wallet/pack-history"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet required")
  })

  it("400s on an unknown collection", async () => {
    state.user = { id: "u1" }
    const res = await GET(req("https://t/api/wallet/pack-history?wallet=0xabc&collection=pokemon"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("unknown collection")
  })

  it("400s on an invalid status", async () => {
    state.user = { id: "u1" }
    const res = await GET(req("https://t/api/wallet/pack-history?wallet=0xabc&status=teleported"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("invalid status")
  })

  it("403s when the wallet is not a verified saved_wallet", async () => {
    state.user = { id: "u1" }
    state.owned = { data: [], error: null }
    expect((await GET(req("https://t/api/wallet/pack-history?wallet=0xabc"))).status).toBe(403)
  })

  it("500s when the verify lookup errors", async () => {
    state.user = { id: "u1" }
    state.owned = { data: null, error: { message: "lookup down" } }
    const res = await GET(req("https://t/api/wallet/pack-history?wallet=0xabc"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("lookup down")
  })

  it("200s and returns the RPC payload for a verified wallet", async () => {
    verified()
    state.rpc = { data: { total: 3, packs: [{ pack_nft_id: "p1" }] }, error: null }
    const res = await GET(req("https://t/api/wallet/pack-history?wallet=0xabc"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.total).toBe(3)
    // status=all default → NULL to the RPC; default limit 50 / offset 0
    expect(state.rpcParams.p_status).toBeNull()
    expect(state.rpcParams.p_limit).toBe(50)
    expect(state.rpcParams.p_offset).toBe(0)
    expect(res.headers.get("Cache-Control")).toContain("no-store")
  })

  it("normalizes a hyphen-form collection slug to the DB form", async () => {
    verified()
    await GET(req("https://t/api/wallet/pack-history?wallet=0xabc&collection=nba-top-shot"))
    expect(state.rpcParams.p_collection_slug).toBe("nba_top_shot")
  })

  it("accepts a DB-form collection slug unchanged", async () => {
    verified()
    await GET(req("https://t/api/wallet/pack-history?wallet=0xabc&collection=nba_top_shot"))
    expect(state.rpcParams.p_collection_slug).toBe("nba_top_shot")
  })

  it("passes an allowlisted status through and clamps the limit to 200", async () => {
    verified()
    await GET(req("https://t/api/wallet/pack-history?wallet=0xabc&status=sold_any&limit=9999"))
    expect(state.rpcParams.p_status).toBe("sold_any")
    expect(state.rpcParams.p_limit).toBe(200)
  })

  it("500s when the history RPC returns an error", async () => {
    verified()
    state.rpc = { data: null, error: { message: "rpc boom" } }
    const res = await GET(req("https://t/api/wallet/pack-history?wallet=0xabc"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("rpc boom")
  })

  it("500s (caught) when the history RPC throws", async () => {
    verified()
    state.rpcThrows = true
    const res = await GET(req("https://t/api/wallet/pack-history?wallet=0xabc"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("rpc exploded")
  })
})
