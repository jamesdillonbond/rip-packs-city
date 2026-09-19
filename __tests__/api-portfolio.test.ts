import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/portfolio — get_cross_collection_portfolio RPC wrapper. Pin the wallet
// guard (with lowercasing), passthrough, and error → 500.

const rpc: { data: any; error: any; lastArgs: any } = { data: null, error: null, lastArgs: null }
vi.mock("@/lib/supabase", () => {
  const call = async (_n: string, args: any) => { rpc.lastArgs = args; return { data: rpc.data, error: rpc.error } }
  return { supabaseAdmin: { rpc: call }, supabase: { rpc: call } }
})

import { GET } from "@/app/api/portfolio/route"
const req = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => { rpc.data = null; rpc.error = null; rpc.lastArgs = null })

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
  // ⛔ This is the CROSS-COLLECTION portfolio, so a Candy wallet is exactly
  // what belongs here — and base58 is CASE-SENSITIVE. 📏 Measured live
  // 2026-09-19: the correct key returns total_fmv 19,386.54; the lowercased one
  // returns a structurally COMPLETE object of zeros (`collections: []`,
  // `total_moments: 0`) that ECHOES the mangled wallet back, so the response
  // reads as a true answer about that wallet rather than as a miss.
  it("⛔ passes a Candy wallet through CASE-INTACT", async () => {
    rpc.data = { collections: [] }
    await GET(req("https://t/api/portfolio?wallet=1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix"))
    expect(rpc.lastArgs?.p_wallet).toBe("1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix")
  })

  it("no-change control: a Flow wallet is still folded to lowercase", async () => {
    rpc.data = { collections: [] }
    await GET(req("https://t/api/portfolio?wallet=0xABCDEF1234567890"))
    expect(rpc.lastArgs?.p_wallet).toBe("0xabcdef1234567890")
  })

  it("500s on an RPC error", async () => {
    rpc.error = { message: "boom" }
    expect((await GET(req("https://t/api/portfolio?wallet=0xabc"))).status).toBe(500)
  })
})
