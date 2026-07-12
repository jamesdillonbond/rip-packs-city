import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/analytics/fmv/top-movers — wrapper over analytics_fmv_top_movers(...) via
// rpcWithRetry. The param parsers (window_days/direction/min_fmv/limit) run for
// real; the happy path asserts the echoed, defaulted/clamped params and that
// out-of-set inputs collapse to defaults.

const state: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: state.data, error: state.error }) },
}))

import { GET } from "@/app/api/analytics/fmv/top-movers/route"

const req = (u: string) => ({ url: u }) as any

beforeEach(() => { state.data = null; state.error = null })

describe("GET /api/analytics/fmv/top-movers", () => {
  it("echoes defaults (window 7, gainers, min_fmv 5) on a bare request", async () => {
    state.data = [{ external_id: "73:2785", pct: 12 }]
    const res = await GET(req("https://t/api/analytics/fmv/top-movers"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual(state.data)
    expect(body.window_days).toBe(7)
    expect(body.direction).toBe("gainers")
    expect(body.min_fmv).toBe(5)
  })

  it("coerces out-of-set params back to defaults and clamps the limit", async () => {
    state.data = []
    // window_days=999 (not in {1,7,30}) → 7; direction=sideways → gainers
    const res = await GET(
      req("https://t/api/analytics/fmv/top-movers?window_days=999&direction=sideways&limit=9999")
    )
    const body = await res.json()
    expect(body.window_days).toBe(7)
    expect(body.direction).toBe("gainers")
    expect(body.rows).toEqual([])
  })

  it("500s with fmv_top_movers_failed on an rpc error", async () => {
    state.error = { message: "boom" }
    const res = await GET(req("https://t/api/analytics/fmv/top-movers"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("fmv_top_movers_failed")
  })
})
