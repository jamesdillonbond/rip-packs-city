import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/analytics/listings/summary — wrapper over analytics_listings_summary(p_collections)
// via rpcWithRetry. Returns the RPC payload verbatim. Pins the happy path and
// the rpc-error → 500.

const state: { data: any; error: any; throws?: boolean } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (state.throws) throw new Error("connection reset")
      return { data: state.data, error: state.error }
    },
  },
}))

import { GET } from "@/app/api/analytics/listings/summary/route"

const req = (u: string) => ({ url: u }) as any

beforeEach(() => { state.data = null; state.error = null; state.throws = false })

describe("GET /api/analytics/listings/summary", () => {
  it("returns the RPC payload verbatim", async () => {
    state.data = { loan_offers: { count: 3 }, topshot_orderbook: { count: 5 } }
    const res = await GET(req("https://t/api/analytics/listings/summary?collections=nba_top_shot"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(state.data)
  })

  it("500s with listings_summary_failed on an rpc error", async () => {
    state.error = { message: "boom" }
    const res = await GET(req("https://t/api/analytics/listings/summary"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("listings_summary_failed")
  })

  it("500s when the rpc throws (outer catch path)", async () => {
    state.throws = true
    const res = await GET(req("https://t/api/analytics/listings/summary"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("listings_summary_failed")
  })
})
