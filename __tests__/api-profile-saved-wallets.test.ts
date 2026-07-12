import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/saved-wallets. All four verbs are
// requireUser-gated (fail-closed 401). Pins the 401s, the POST/DELETE/PATCH
// param 400s (walletAddr required), the PATCH invalid-JSON 400, and a mocked
// GET happy path (non-empty saved wallets short-circuit the auto-attach).

const state: { user: any; result: any } = {
  user: null,
  result: { data: [], error: null, count: 0 },
}

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b, insert: () => b, update: () => b, upsert: () => b,
      delete: () => b, eq: () => b, order: () => b, limit: () => b,
      single: async () => state.result,
      maybeSingle: async () => state.result,
      then: (resolve: any) => resolve(state.result),
    }
    return b
  }
  const client: any = { from: () => build(), rpc: async () => state.result }
  return { supabase: client, supabaseAdmin: client }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user)
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    return state.user
  },
  getCurrentUser: async () => state.user,
}))

vi.mock("@/lib/pro-tier", () => ({
  checkFeatureQuota: async () => ({ daily_limit: null, plan: "pro_paid" }),
}))

import { GET, POST, DELETE, PATCH } from "@/app/api/profile/saved-wallets/route"

const req = (url: string, body?: any, throws = false) =>
  ({
    nextUrl: new URL(url),
    json: async () => {
      if (throws) throw new Error("bad json")
      return body
    },
  }) as any

beforeEach(() => {
  state.user = null
  state.result = { data: [], error: null, count: 0 }
})

describe("/api/profile/saved-wallets", () => {
  it("GET 401s when unauthenticated (fail-closed)", async () => {
    expect((await GET(req("https://t/api/profile/saved-wallets"))).status).toBe(401)
  })

  it("POST 401s when unauthenticated (fail-closed)", async () => {
    expect(
      (await POST(req("https://t/api/profile/saved-wallets", { walletAddr: "0xabc" }))).status
    ).toBe(401)
  })

  it("POST 400s without walletAddr", async () => {
    state.user = { id: "u1" }
    const res = await POST(req("https://t/api/profile/saved-wallets", {}))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("walletAddr required")
  })

  it("DELETE 400s without walletAddr", async () => {
    state.user = { id: "u1" }
    expect((await DELETE(req("https://t/api/profile/saved-wallets", {}))).status).toBe(400)
  })

  it("PATCH 400s on invalid JSON body", async () => {
    state.user = { id: "u1" }
    const res = await PATCH(req("https://t/api/profile/saved-wallets", undefined, true))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON body")
  })

  it("PATCH 400s without walletAddr", async () => {
    state.user = { id: "u1" }
    expect((await PATCH(req("https://t/api/profile/saved-wallets", {}))).status).toBe(400)
  })

  it("GET returns saved wallets on the happy path", async () => {
    state.user = { id: "u1" }
    state.result = {
      data: [{ id: "w1", wallet_addr: "0xabc", collection_id: "c1", cached_fmv_usd: 42 }],
      error: null,
    }
    const res = await GET(req("https://t/api/profile/saved-wallets"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.wallets).toHaveLength(1)
    expect(body.wallets[0].cached_fmv).toBe(42)
  })
})
