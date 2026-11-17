import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/analytics/sales/top-moves. No guards;
// wraps analytics_sales_top_moves and returns { rows }. Pins the happy path,
// the null→[] empty path, and the rpc-error 500.

const rpc: { data: any; error: any; throws?: boolean } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (rpc.throws) throw new Error("connection reset")
      return { data: rpc.data, error: rpc.error }
    },
  },
}))

import { GET } from "@/app/api/analytics/sales/top-moves/route"

const req = (url = "https://t/api/analytics/sales/top-moves") => ({ url }) as any

beforeEach(() => { rpc.data = null; rpc.error = null; rpc.throws = false })

describe("GET /api/analytics/sales/top-moves", () => {
  it("wraps the rpc rows under { rows }", async () => {
    rpc.data = [{ price_usd: 5000, player: "Lillard" }]
    const res = await GET(req("https://t/api/analytics/sales/top-moves?window=l7&limit=5"))
    expect(res.status).toBe(200)
    expect((await res.json()).rows).toEqual([{ price_usd: 5000, player: "Lillard" }])
  })

  it("returns { rows: [] } when the rpc yields null", async () => {
    rpc.data = null
    expect((await (await GET(req())).json()).rows).toEqual([])
  })

  it("500s on an rpc error", async () => {
    rpc.error = { message: "db" }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("top_moves_failed")
  })

  it("500s when the rpc throws (outer catch path)", async () => {
    rpc.throws = true
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("top_moves_failed")
  })
})
