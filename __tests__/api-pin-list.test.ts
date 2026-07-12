import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/pin-list.
// requireUser-gated (fail-closed 401), then wallet-required (400), format
// validation (400), saved_wallets ownership gate (403), then the single-row
// get_wallet_ipfs_pin_export RPC. Pins each pre-RPC guard plus a mocked
// json-format happy path.

const state: { user: any; owned: any; exp: any } = {
  user: null,
  owned: { data: [], error: null },
  exp: { data: {}, error: null },
}

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b,
      eq: () => b,
      limit: async () => state.owned,
    }
    return b
  }
  const client: any = { from: () => build(), rpc: async () => state.exp }
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

import { GET } from "@/app/api/pin-list/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.user = null
  state.owned = { data: [], error: null }
  state.exp = { data: {}, error: null }
})

describe("GET /api/pin-list", () => {
  it("401s when unauthenticated", async () => {
    const res = (await GET(req("https://t/api/pin-list?wallet=0xabc"))) as Response
    expect(res.status).toBe(401)
  })

  it("400s without a wallet param", async () => {
    state.user = { id: "u1" }
    const res = await GET(req("https://t/api/pin-list"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet required")
  })

  it("400s on an invalid format", async () => {
    state.user = { id: "u1" }
    const res = await GET(req("https://t/api/pin-list?wallet=0xabc&format=xml"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid format: xml")
  })

  it("403s when the wallet is not saved on this account", async () => {
    state.user = { id: "u1" }
    state.owned = { data: [], error: null }
    const res = await GET(req("https://t/api/pin-list?wallet=0xabc"))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("wallet not saved on this account")
  })

  it("returns the json summary for a saved wallet", async () => {
    state.user = { id: "u1" }
    state.owned = { data: [{ wallet_addr: "0xabc" }], error: null }
    state.exp = {
      data: {
        cid_count: 3,
        total_bytes: 2048,
        video: { count: 1, bytes: 1024 },
        artwork: { count: 2, bytes: 1024 },
        by_type: { VIDEO: 1, ARTWORK: 2 },
        cids_text: "cid1\ncid2\ncid3",
      },
      error: null,
    }
    const res = await GET(req("https://t/api/pin-list?wallet=0xABC"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.wallet).toBe("0xabc") // lower-cased
    expect(body.cid_count).toBe(3)
    expect(body.total_bytes).toBe(2048)
    expect(body.total_human).toBe("2 KB")
    expect(body.by_type).toEqual({ VIDEO: 1, ARTWORK: 2 })
  })
})
