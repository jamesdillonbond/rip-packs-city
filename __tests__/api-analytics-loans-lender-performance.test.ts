import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/analytics/loans/lender-performance — wrapper over
// analytics_lender_performance(...) via rpcWithRetry. Pins the { rows } envelope
// on the happy/empty path and the rpc-error → 500.

const state: { data: any; error: any; throws?: boolean } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (state.throws) throw new Error("connection reset")
      return { data: state.data, error: state.error }
    },
  },
}))

import { GET } from "@/app/api/analytics/loans/lender-performance/route"

const req = (u: string) => ({ url: u }) as any

beforeEach(() => { state.data = null; state.error = null; state.throws = false })

describe("GET /api/analytics/loans/lender-performance", () => {
  it("wraps the RPC rows in a { rows } envelope", async () => {
    state.data = [{ addr: "0xabc", realized_yield_pct: 8.2 }]
    const res = await GET(req("https://t/api/analytics/loans/lender-performance?min_loans=3&limit=10"))
    expect(res.status).toBe(200)
    expect((await res.json()).rows).toEqual(state.data)
  })

  it("returns an empty rows array when the RPC returns null", async () => {
    state.data = null
    const res = await GET(req("https://t/api/analytics/loans/lender-performance"))
    expect(res.status).toBe(200)
    expect((await res.json()).rows).toEqual([])
  })

  it("500s with lender_performance_failed on an rpc error", async () => {
    state.error = { message: "boom" }
    const res = await GET(req("https://t/api/analytics/loans/lender-performance"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("lender_performance_failed")
  })

  it("500s when the rpc throws (outer catch path)", async () => {
    state.throws = true
    const res = await GET(req("https://t/api/analytics/loans/lender-performance"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("lender_performance_failed")
  })
})
