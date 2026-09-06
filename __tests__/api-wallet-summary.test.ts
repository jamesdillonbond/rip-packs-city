import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/wallet-summary — get_wallet_summary RPC wrapper. Pin the wallet guard,
// the RPC passthrough, the error → 500 path, and (2026-09-06) the USERNAME
// path: the RPC takes an address, the front door tells readers to paste a
// username, and the mismatch published "$0 · 0 unlocked · 0 locked" for a
// 15,284-Moment wallet under HTTP 200. A username now resolves through the
// cached ladder; an unresolved one is a 404, never a row of zeros.

const rpc: { data: any; error: any; lastArgs: any } = { data: null, error: null, lastArgs: null }
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: async (_n: string, args: any) => { rpc.lastArgs = args; return { data: rpc.data, error: rpc.error } } }),
}))
const resolver = { result: null as string | null, calls: [] as string[] }
vi.mock("@/lib/chains/flow/topshot-username-resolve", async (orig) => {
  const real = await orig<typeof import("@/lib/chains/flow/topshot-username-resolve")>()
  return {
    ...real,
    lookupCachedTopShotUsername: async (_c: unknown, u: string) => { resolver.calls.push(u); return resolver.result },
  }
})

import { GET } from "@/app/api/wallet-summary/route"
const req = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => { rpc.data = null; rpc.error = null; rpc.lastArgs = null; resolver.result = null; resolver.calls = [] })

describe("GET /api/wallet-summary", () => {
  it("400s without a wallet", async () => {
    expect((await GET(req("https://t/api/wallet-summary"))).status).toBe(400)
  })
  it("returns the RPC data on success and names the address it read", async () => {
    rpc.data = { totalMoments: 5 }
    const res = await GET(req("https://t/api/wallet-summary?wallet=0xb5081692483c2336"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ totalMoments: 5, resolved_wallet: "0xb5081692483c2336" })
    expect(resolver.calls).toEqual([]) // an address never hits the resolver
    expect(rpc.lastArgs.p_wallet).toBe("0xb5081692483c2336")
  })
  it("500s on an RPC error", async () => {
    rpc.error = { message: "nope" }
    const res = await GET(req("https://t/api/wallet-summary?wallet=0xb5081692483c2336"))
    expect(res.status).toBe(500)
    // The driver message must NOT be published — lib/api-error.ts classifies it.
    expect((await res.json()).error).not.toContain("nope")
  })

  it("resolves a Top Shot username to its address BEFORE calling the RPC", async () => {
    resolver.result = "0xb5081692483c2336"
    rpc.data = { total_moments: 15284, wallet_fmv: 28480.29 }
    const res = await GET(req("https://t/api/wallet-summary?wallet=jamesdillonbond&collection=nba-top-shot"))
    expect(res.status).toBe(200)
    expect(resolver.calls).toEqual(["jamesdillonbond"])
    expect(rpc.lastArgs.p_wallet).toBe("0xb5081692483c2336")
    expect(await res.json()).toMatchObject({ total_moments: 15284, resolved_wallet: "0xb5081692483c2336" })
  })

  it("an unresolved username is a 404 — the RPC is never asked, so zeros can never be published", async () => {
    resolver.result = null
    rpc.data = { total_moments: 0, wallet_fmv: 0, unlocked_fmv: 0, locked_fmv: 0 }
    const res = await GET(req("https://t/api/wallet-summary?wallet=nobody-here"))
    expect(res.status).toBe(404)
    expect(rpc.lastArgs).toBeNull()
    const body = await res.json()
    expect(body.error).toBe("unresolved")
    expect(body).not.toHaveProperty("wallet_fmv")
  })
})
