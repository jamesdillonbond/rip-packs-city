import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/wallet/pack-lifecycle. requireUser() runs
// first → fail-closed 401 when unauthenticated, before the wallet/packNftId
// guard. Success path: a signed-in user whose requested wallet is a verified
// saved_wallet reaches get_pack_lifecycle — ownership chain resolves a match
// and the RPC fixture is returned.

const state: { user: any; owned: any; rpc: any } = {
  user: null,
  owned: { data: [], error: null },
  rpc: { data: null, error: null },
}

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b, eq: () => b, not: () => b, limit: () => b,
    then: (resolve: any) => resolve(state.owned),
  }
  return { supabaseAdmin: { from: () => b, rpc: async () => state.rpc } }
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
})
