import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/portfolio — get_cross_collection_portfolio RPC wrapper. Pin the wallet
// guard (with lowercasing), passthrough, and error → 500.

const rpc: { data: any; error: any } = { data: null, error: null }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
  supabase: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/portfolio/route"
const req = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => { rpc.data = null; rpc.error = null })

describe("GET /api/portfolio", () => {
  it("400s without a wallet", async () => {
    expect((await GET(req("https://t/api/portfolio"))).status).toBe(400)
    expect((await GET(req("https://t/api/portfolio?wallet=%20"))).status).toBe(400)
  })
  it("returns the portfolio data on success", async () => {
    rpc.data = { collections: [{ slug: "nba-top-shot" }] }
    const res = await GET(req("https://t/api/portfolio?wallet=0xABC"))
    expect(res.status).toBe(200)
    expect((await res.json()).collections).toHaveLength(1)
  })
  it("defaults null data to an empty object", async () => {
    rpc.data = null
    const res = await GET(req("https://t/api/portfolio?wallet=0xabc"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })
  it("500s on an RPC error", async () => {
    rpc.error = { message: "boom" }
    expect((await GET(req("https://t/api/portfolio?wallet=0xabc"))).status).toBe(500)
  })
})
