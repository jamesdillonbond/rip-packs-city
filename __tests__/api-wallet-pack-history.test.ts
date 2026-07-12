import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/wallet/pack-history. requireUser() runs
// first and throws a 401 Response when unauthenticated → fail-closed 401 before
// the wallet guard. Success path: a signed-in user whose requested wallet is a
// verified saved_wallet reaches get_wallet_pack_history — the saved_wallets
// ownership chain resolves a match and the RPC returns a fixture we assert on.

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

import { GET } from "@/app/api/wallet/pack-history/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => {
  state.user = null
  state.owned = { data: [], error: null }
  state.rpc = { data: null, error: null }
})

describe("GET /api/wallet/pack-history", () => {
  it("401s when unauthenticated (requireUser fail-closed)", async () => {
    const res = await GET(req("https://t/api/wallet/pack-history?wallet=0xabc"))
    expect(res.status).toBe(401)
  })

  it("403s when the wallet is not a verified saved_wallet", async () => {
    state.user = { id: "u1" }
    state.owned = { data: [], error: null }
    const res = await GET(req("https://t/api/wallet/pack-history?wallet=0xabc"))
    expect(res.status).toBe(403)
  })

  it("200s and returns the RPC payload for a verified wallet", async () => {
    state.user = { id: "u1" }
    state.owned = { data: [{ wallet_addr: "0xabc" }], error: null }
    state.rpc = { data: { total: 3, packs: [{ pack_nft_id: "p1" }] }, error: null }
    const res = await GET(req("https://t/api/wallet/pack-history?wallet=0xabc"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.total).toBe(3)
    expect(body.packs[0].pack_nft_id).toBe("p1")
  })
})
