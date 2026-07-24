import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/analytics/packs/fresh — wrapper over analytics_packs_fresh(...) via
// rpcWithRetry. parseHours/parseNumeric/parseLimit run for real. Pins the
// echoed (clamped/defaulted) params on the happy path and the rpc-error → 500.

const state: { data: any; error: any; throws?: boolean } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (state.throws) throw new Error("connection reset")
      return { data: state.data, error: state.error }
    },
  },
}))

import { GET } from "@/app/api/analytics/packs/fresh/route"

const req = (u: string) => ({ url: u }) as any

beforeEach(() => { state.data = null; state.error = null; state.throws = false })

describe("GET /api/analytics/packs/fresh", () => {
  it("echoes defaults (hours 24, min 1, max 5000) on a bare request", async () => {
    state.data = [{ id: "p1", ask: 12 }]
    const res = await GET(req("https://t/api/analytics/packs/fresh"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual(state.data)
    expect(body.hours).toBe(24)
    expect(body.min_price).toBe(1)
    expect(body.max_price).toBe(5000)
  })

  it("clamps hours to the 168 ceiling", async () => {
    state.data = []
    const body = await (await GET(req("https://t/api/analytics/packs/fresh?hours=9999"))).json()
    expect(body.hours).toBe(168)
    expect(body.rows).toEqual([])
  })

  it("500s with packs_fresh_failed on an rpc error", async () => {
    state.error = { message: "boom" }
    const res = await GET(req("https://t/api/analytics/packs/fresh"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("packs_fresh_failed")
  })

  it("500s when the rpc throws (outer catch path)", async () => {
    state.throws = true
    const res = await GET(req("https://t/api/analytics/packs/fresh"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("packs_fresh_failed")
  })
})
