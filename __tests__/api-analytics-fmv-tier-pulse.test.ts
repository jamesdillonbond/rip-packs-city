import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/analytics/fmv/tier-pulse — wrapper over analytics_fmv_tier_pulse(p_collections)
// via rpcWithRetry. Pins the { rows } envelope on the happy/empty path and the
// rpc-error → 500.

const state: { data: any; error: any; throws?: boolean } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (state.throws) throw new Error("connection reset")
      return { data: state.data, error: state.error }
    },
  },
}))

import { GET } from "@/app/api/analytics/fmv/tier-pulse/route"

const req = (u: string) => ({ url: u }) as any

beforeEach(() => { state.data = null; state.error = null; state.throws = false })

describe("GET /api/analytics/fmv/tier-pulse", () => {
  it("wraps the RPC rows in a { rows } envelope", async () => {
    state.data = [{ tier: "LEGENDARY", count: 5 }]
    const res = await GET(req("https://t/api/analytics/fmv/tier-pulse"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual(state.data)
  })

  it("returns an empty rows array when the RPC returns null", async () => {
    state.data = null
    const res = await GET(req("https://t/api/analytics/fmv/tier-pulse"))
    expect(res.status).toBe(200)
    expect((await res.json()).rows).toEqual([])
  })

  it("500s with fmv_tier_pulse_failed on an rpc error", async () => {
    state.error = { message: "boom" }
    const res = await GET(req("https://t/api/analytics/fmv/tier-pulse"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("fmv_tier_pulse_failed")
  })

  it("500s when the rpc throws (outer catch path)", async () => {
    state.throws = true
    const res = await GET(req("https://t/api/analytics/fmv/tier-pulse"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("fmv_tier_pulse_failed")
  })
})
