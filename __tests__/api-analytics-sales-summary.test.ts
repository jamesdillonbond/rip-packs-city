import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/analytics/sales/summary. No guards; wraps
// analytics_sales_summary and returns the jsonb verbatim. Pins the happy
// pass-through and the rpc-error 500.

const rpc: { data: any; error: any; throws?: boolean } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (rpc.throws) throw new Error("connection reset")
      return { data: rpc.data, error: rpc.error }
    },
  },
}))

import { GET } from "@/app/api/analytics/sales/summary/route"

const req = (url = "https://t/api/analytics/sales/summary") => ({ url }) as any

beforeEach(() => { rpc.data = null; rpc.error = null; rpc.throws = false })

describe("GET /api/analytics/sales/summary", () => {
  it("returns the rpc payload verbatim", async () => {
    rpc.data = { total_sales: 500, p50: 12 }
    const res = await GET(req("https://t/api/analytics/sales/summary?window=l30"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ total_sales: 500, p50: 12 })
  })

  it("500s on an rpc error", async () => {
    rpc.error = { message: "db" }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("summary_failed")
  })

  it("500s when the rpc throws (outer catch path)", async () => {
    rpc.throws = true
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("summary_failed")
  })
})
