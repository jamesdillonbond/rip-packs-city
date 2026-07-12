import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/collection-moments. No auth. The `wallet`
// param is required (400 if absent). A raw 0x…(18-char) address resolves without
// any network call, so the happy path only needs the Supabase RPC seam mocked:
// get_wallet_moments_with_fmv (page + count), get_wallet_total_fmv (thenable),
// and get_acquisition_stats. A raw RPC error on the primary call → 500.

const state: { moments: any; momentsError: any; totalFmv: any } = {
  moments: { moments: [], total_count: 0 },
  momentsError: null,
  totalFmv: 0,
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string) => {
      if (name === "get_wallet_moments_with_fmv") {
        return { data: state.moments, error: state.momentsError }
      }
      if (name === "get_wallet_total_fmv") return { data: state.totalFmv, error: null }
      if (name === "get_acquisition_stats") return { data: null, error: null }
      return { data: null, error: null }
    },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }) }),
  },
}))

import { GET } from "@/app/api/collection-moments/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any
const WALLET = "0xbd94cade097e50ac" // 0x + 16 hex = 18 chars → resolves locally

beforeEach(() => {
  state.moments = { moments: [], total_count: 0 }
  state.momentsError = null
  state.totalFmv = 0
})

describe("GET /api/collection-moments", () => {
  it("400s when the wallet param is missing", async () => {
    const res = await GET(req("https://t/api/collection-moments"))
    expect(res.status).toBe(400)
    expect((await res.json()).message).toContain("wallet parameter is required")
  })

  it("returns an empty page for a wallet with no cached moments", async () => {
    const res = await GET(req(`https://t/api/collection-moments?wallet=${WALLET}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.moments).toEqual([])
    expect(body.total_count).toBe(0)
    expect(body.wallet).toBe(WALLET)
    expect(body.total_pages).toBe(0)
  })

  it("500s when the moments RPC returns an error", async () => {
    state.momentsError = { message: "rpc boom" }
    const res = await GET(req(`https://t/api/collection-moments?wallet=${WALLET}`))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Database query failed")
  })
})
