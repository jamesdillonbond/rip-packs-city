import { describe, it, expect, beforeEach, vi } from "vitest"

// Route test for /api/profile/held-pack-value — sealed packs across every saved
// wallet at the lowest live ask, shown beside the dashboard's aggregated value
// (Trevor, 2026-11-21). Pins: auth required; one read per DISTINCT Flow address
// (Solana skipped); a failed wallet read is counted, never folded in as $0.

const state: {
  saved: { data: any; error: any }
  packs: Record<string, { data: any; error: any }>
  calls: string[]
  authed: boolean
} = { saved: { data: [], error: null }, packs: {}, calls: [], authed: true }

function chain(getResult: () => any): any {
  const b: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (res: any, rej: any) => Promise.resolve(getResult()).then(res, rej)
      return () => b
    },
  })
  return b
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => chain(() => state.saved),
    rpc: (_fn: string, args: { p_wallet: string }) => {
      state.calls.push(args.p_wallet)
      return Promise.resolve(state.packs[args.p_wallet] ?? { data: null, error: { message: "boom" } })
    },
  },
}))

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.authed) throw new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
    return { id: "u1" }
  },
}))

import { GET } from "@/app/api/profile/held-pack-value/route"

beforeEach(() => {
  state.saved = { data: [], error: null }
  state.packs = {}
  state.calls = []
  state.authed = true
})

describe("GET /api/profile/held-pack-value", () => {
  it("requires a signed-in user", async () => {
    state.authed = false
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it("sums every distinct saved Flow wallet and skips non-Flow addresses", async () => {
    state.saved = { data: [
      { wallet_addr: "0xba1a13299beb4b19" },
      { wallet_addr: "0xBA1A13299BEB4B19" },
      { wallet_addr: "0xaf78a4360000fe85" },
      { wallet_addr: "7Xq9GxvP8wD3mK2nR5tY1uV6bC4aE8fH2jL9pQ3sZ6wN" },
    ], error: null }
    state.packs = {
      "0xba1a13299beb4b19": { data: { count: 327, listed_count: 273, floor_ask_usd: 30961.2 }, error: null },
      "0xaf78a4360000fe85": { data: { count: 28, listed_count: 28, floor_ask_usd: 922.99 }, error: null },
    }
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ held: 355, listed: 301, low_ask_usd: 31884.19, unpriced: 0, wallets: 2, wallets_failed: 0, by_wallet: {} })
    expect(state.calls.sort()).toEqual(["0xaf78a4360000fe85", "0xba1a13299beb4b19"])
  })

  it("counts a failed wallet read instead of folding it in as $0", async () => {
    state.saved = { data: [{ wallet_addr: "0xba1a13299beb4b19" }, { wallet_addr: "0xaf78a4360000fe85" }], error: null }
    state.packs = {
      "0xaf78a4360000fe85": { data: { count: 28, listed_count: 28, floor_ask_usd: 922.99 }, error: null },
    }
    const body = await (await GET()).json()
    expect(body.wallets_failed).toBe(1)
    expect(body.low_ask_usd).toBe(922.99)
  })

  it("errors when the saved-wallets read fails", async () => {
    state.saved = { data: null, error: { message: "db down", code: "57014" } }
    const res = await GET()
    expect(res.status).toBeGreaterThanOrEqual(500)
  })
})
