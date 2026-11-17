import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/analytics/loans/timeseries — wrapper over flowty_analytics_timeseries(...)
// via rpcWithRetry. parseBucket runs for real. Pins the { rows, bucket } envelope
// on the happy path (including bucket coercion) and the rpc-error → 500.

const state: { data: any; error: any; throws?: boolean } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (state.throws) throw new Error("connection reset")
      return { data: state.data, error: state.error }
    },
  },
}))

import { GET } from "@/app/api/analytics/loans/timeseries/route"

const req = (u: string) => ({ url: u }) as any

beforeEach(() => { state.data = null; state.error = null; state.throws = false })

describe("GET /api/analytics/loans/timeseries", () => {
  it("echoes an explicit bucket and returns rows", async () => {
    state.data = [{ bucket: "2026-07-01", collection: "nba_top_shot", volume: 10 }]
    const res = await GET(req("https://t/api/analytics/loans/timeseries?bucket=week"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.bucket).toBe("week")
    expect(body.rows).toEqual(state.data)
  })

  it("coerces an unknown bucket to auto", async () => {
    state.data = []
    const body = await (await GET(req("https://t/api/analytics/loans/timeseries?bucket=year"))).json()
    expect(body.bucket).toBe("auto")
    expect(body.rows).toEqual([])
  })

  it("500s with timeseries_failed on an rpc error", async () => {
    state.error = { message: "boom" }
    const res = await GET(req("https://t/api/analytics/loans/timeseries"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("timeseries_failed")
  })

  it("500s when the rpc throws (outer catch path)", async () => {
    state.throws = true
    const res = await GET(req("https://t/api/analytics/loans/timeseries"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("timeseries_failed")
  })
})
