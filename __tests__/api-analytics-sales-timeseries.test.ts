import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/analytics/sales/timeseries. No guards;
// wraps analytics_sales_timeseries and returns { rows, bucket }. Pins the happy
// path (bucket param echoed, defaulting an unknown bucket to "auto") and the
// rpc-error 500.

const rpc: { data: any; error: any; throws?: boolean } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (rpc.throws) throw new Error("connection reset")
      return { data: rpc.data, error: rpc.error }
    },
  },
}))

import { GET } from "@/app/api/analytics/sales/timeseries/route"

const req = (url = "https://t/api/analytics/sales/timeseries") => ({ url }) as any

beforeEach(() => { rpc.data = null; rpc.error = null; rpc.throws = false })

describe("GET /api/analytics/sales/timeseries", () => {
  it("returns { rows, bucket } defaulting an unknown bucket to auto", async () => {
    rpc.data = [{ bucket: "2026-07-12", collection: "topshot", volume: 9 }]
    const res = await GET(req("https://t/api/analytics/sales/timeseries?bucket=month"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual([{ bucket: "2026-07-12", collection: "topshot", volume: 9 }])
    expect(body.bucket).toBe("auto")
  })

  it("echoes a valid bucket param", async () => {
    rpc.data = []
    const body = await (await GET(req("https://t/api/analytics/sales/timeseries?bucket=week"))).json()
    expect(body.bucket).toBe("week")
    expect(body.rows).toEqual([])
  })

  it("500s on an rpc error", async () => {
    rpc.error = { message: "db" }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("timeseries_failed")
  })

  it("500s when the rpc throws (outer catch path)", async () => {
    rpc.throws = true
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("timeseries_failed")
  })
})
