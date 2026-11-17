import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/analytics/packs/summary. No guards — a
// thin rpcWithRetry(supabaseAdmin, "analytics_packs_summary") wrapper. Pins the
// happy pass-through (data returned verbatim) and the rpc-error 500.

const rpc: { data: any; error: any; throws?: boolean } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (rpc.throws) throw new Error("connection reset")
      return { data: rpc.data, error: rpc.error }
    },
  },
}))

import { GET } from "@/app/api/analytics/packs/summary/route"

const req = (url = "https://t/api/analytics/packs/summary") => ({ url }) as any

beforeEach(() => { rpc.data = null; rpc.error = null; rpc.throws = false })

describe("GET /api/analytics/packs/summary", () => {
  it("returns the rpc payload verbatim", async () => {
    rpc.data = [{ collection: "nba_top_shot", count: 3 }]
    const res = await GET(req("https://t/api/analytics/packs/summary?collections=topshot"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ collection: "nba_top_shot", count: 3 }])
  })

  it("500s on an rpc error", async () => {
    rpc.error = { message: "db" }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("packs_summary_failed")
  })

  it("500s when the rpc throws (outer catch path)", async () => {
    rpc.throws = true
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("packs_summary_failed")
  })
})
