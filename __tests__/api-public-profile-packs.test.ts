import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/public/profile/<username>/packs — sealed packs across the wallets the
// profile OWNS (same set its Portfolio FMV sums), at the lowest live ask
// (2026-11-21). Pins: only owned addresses are read; no address is published;
// the profile's own failure status passes through.

const state: { result: any; owned: string[]; packs: Record<string, any>; calls: string[] } = {
  result: null, owned: [], packs: {}, calls: [],
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: (_fn: string, args: { p_wallet: string }) => {
      state.calls.push(args.p_wallet)
      return Promise.resolve(state.packs[args.p_wallet] ?? { data: null, error: { message: "boom" } })
    },
  },
}))

vi.mock("@/lib/profile/public-profile", () => ({
  getPublicProfile: async () => state.result,
  publicProfileOwnedAddresses: () => state.owned,
}))

import { NextRequest } from "next/server"
import { GET } from "@/app/api/public/profile/[username]/packs/route"

const call = () => GET(new NextRequest("https://x.test/api/public/profile/trevor/packs"), { params: Promise.resolve({ username: "trevor" }) })

beforeEach(() => {
  state.result = { ok: true, data: { username: "trevor" } }
  state.owned = []
  state.packs = {}
  state.calls = []
})

describe("GET /api/public/profile/<username>/packs", () => {
  it("passes the profile's 404 through", async () => {
    state.result = { ok: false, status: 404, error: "Not found" }
    expect((await call()).status).toBe(404)
  })
  it("sums only the owned Flow wallets and publishes no address", async () => {
    state.owned = ["0xba1a13299beb4b19", "0xaf78a4360000fe85"]
    state.packs = {
      "0xba1a13299beb4b19": { data: { count: 327, listed_count: 273, floor_ask_usd: 30961.2 }, error: null },
      "0xaf78a4360000fe85": { data: { count: 28, listed_count: 28, floor_ask_usd: 922.99 }, error: null },
    }
    const res = await call()
    const body = await res.json()
    expect(body).toEqual({ held: 355, listed: 301, low_ask_usd: 31884.19, wallets_failed: 0 })
    expect(JSON.stringify(body)).not.toContain("0x")
    expect(state.calls.sort()).toEqual(["0xaf78a4360000fe85", "0xba1a13299beb4b19"])
    expect(res.headers.get("cache-control")).toContain("s-maxage=600")
  })
  it("does not cache a partial answer", async () => {
    state.owned = ["0xba1a13299beb4b19"]
    const res = await call()
    expect((await res.json()).wallets_failed).toBe(1)
    expect(res.headers.get("cache-control")).toBe("no-store")
  })
})
