import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/wallet-cache. GET requires ?wallet= → 400,
// else returns cached moments. POST is lenient: a missing wallet / moments array
// short-circuits to { ok: true, written: 0 } (never a hard error). Mocks
// supabaseAdmin's read chain + upsert_wmc_batch RPC.

const state: { data: any; error: any } = { data: [], error: null }
vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b, eq: () => b, order: () => b, single: async () => ({ data: null }),
    limit: async () => ({ data: state.data, error: state.error }),
  }
  return { supabaseAdmin: { from: () => b, rpc: async () => ({ data: { written: 0 }, error: null }) } }
})

import { GET, POST } from "@/app/api/wallet-cache/route"

const getReq = (u: string) => ({ nextUrl: new URL(u) }) as any
const postReq = (body: any) => ({ json: async () => body }) as any

beforeEach(() => { state.data = []; state.error = null })

describe("/api/wallet-cache", () => {
  it("GET 400s without a wallet", async () => {
    const res = await GET(getReq("https://t/api/wallet-cache"))
    expect(res.status).toBe(400)
  })
  it("GET returns cached moments for a wallet", async () => {
    state.data = [{ moment_id: "1" }]
    const res = await GET(getReq("https://t/api/wallet-cache?wallet=0xabc"))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
  it("POST short-circuits to written:0 without wallet/moments", async () => {
    const res = await POST(postReq({}))
    expect(res.status).toBe(200)
    expect((await res.json()).written).toBe(0)
  })
})
