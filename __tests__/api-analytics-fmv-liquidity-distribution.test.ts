import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/analytics/fmv/liquidity-distribution — wrapper over
// analytics_liquidity_distribution(p_collections) via rpcWithRetry. parseCollections
// runs for real. Pins the happy path plus the null-data fallback (empty rows) and
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

import { GET } from "@/app/api/analytics/fmv/liquidity-distribution/route"

const req = (u: string) => ({ url: u }) as any

beforeEach(() => { state.data = null; state.error = null; state.throws = false })

describe("GET /api/analytics/fmv/liquidity-distribution", () => {
  it("returns the RPC payload for a collections filter", async () => {
    state.data = { as_of: "2026-07-12T00:00:00Z", rows: [{ collection: "nba_top_shot", l5: 3 }] }
    const res = await GET(req("https://t/api/analytics/fmv/liquidity-distribution?collections=nba_top_shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toHaveLength(1)
  })

  it("falls back to an empty rows payload when the RPC returns null", async () => {
    state.data = null
    const res = await GET(req("https://t/api/analytics/fmv/liquidity-distribution"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual([])
    expect(typeof body.as_of).toBe("string")
  })

  it("500s with liquidity_distribution_failed on an rpc error", async () => {
    state.error = { message: "boom" }
    const res = await GET(req("https://t/api/analytics/fmv/liquidity-distribution"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("liquidity_distribution_failed")
  })

  it("500s when the rpc throws (outer catch path)", async () => {
    state.throws = true
    const res = await GET(req("https://t/api/analytics/fmv/liquidity-distribution"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("liquidity_distribution_failed")
  })
})
