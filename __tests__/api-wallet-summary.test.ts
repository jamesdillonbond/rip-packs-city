import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/wallet-summary — thin get_wallet_summary RPC wrapper. Pin the wallet
// guard, the RPC passthrough, and the error → 500 path.

const rpc: { data: any; error: any } = { data: null, error: null }
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: async () => ({ data: rpc.data, error: rpc.error }) }),
}))

import { GET } from "@/app/api/wallet-summary/route"
const req = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => { rpc.data = null; rpc.error = null })

describe("GET /api/wallet-summary", () => {
  it("400s without a wallet", async () => {
    expect((await GET(req("https://t/api/wallet-summary"))).status).toBe(400)
  })
  it("returns the RPC data on success", async () => {
    rpc.data = { totalMoments: 5 }
    const res = await GET(req("https://t/api/wallet-summary?wallet=0xabc"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ totalMoments: 5 })
  })
  it("500s on an RPC error", async () => {
    rpc.error = { message: "nope" }
    const res = await GET(req("https://t/api/wallet-summary?wallet=0xabc"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("nope")
  })
})
