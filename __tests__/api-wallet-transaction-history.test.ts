import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/wallet/transaction-history. requireUser()
// runs first → fail-closed 401 when unauthenticated, before the wallet/kind
// guard. Success path: a signed-in user whose requested wallet is a verified
// saved_wallet reaches get_wallet_transaction_history — ownership chain resolves
// a match and the RPC fixture is returned. Also covers the invalid-kind 400.

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

import { GET } from "@/app/api/wallet/transaction-history/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => {
  state.user = null
  state.owned = { data: [], error: null }
  state.rpc = { data: null, error: null }
})

describe("GET /api/wallet/transaction-history", () => {
  it("401s when unauthenticated (requireUser fail-closed)", async () => {
    const res = await GET(req("https://t/api/wallet/transaction-history?wallet=0xabc"))
    expect(res.status).toBe(401)
  })

  it("400s on an invalid kind", async () => {
    state.user = { id: "u1" }
    const res = await GET(req("https://t/api/wallet/transaction-history?wallet=0xabc&kind=bogus"))
    expect(res.status).toBe(400)
  })

  it("200s and returns the RPC timeline for a verified wallet", async () => {
    state.user = { id: "u1" }
    state.owned = { data: [{ wallet_addr: "0xabc" }], error: null }
    state.rpc = { data: { total: 2, events: [{ kind: "buy" }] }, error: null }
    const res = await GET(req("https://t/api/wallet/transaction-history?wallet=0xabc"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.total).toBe(2)
    expect(body.events[0].kind).toBe("buy")
  })
})
