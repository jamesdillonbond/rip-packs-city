import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/analytics/sets/directory. No guards;
// wraps analytics_sets_directory and returns { rows, sort, min_coverage,
// limit }. Pins the happy path (unknown sort falls back to value_desc,
// min_coverage clamped) and the rpc-error 500.

const rpc: { data: any; error: any; throws?: boolean } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (rpc.throws) throw new Error("connection reset")
      return { data: rpc.data, error: rpc.error }
    },
  },
}))

import { GET } from "@/app/api/analytics/sets/directory/route"

const req = (url = "https://t/api/analytics/sets/directory") => ({ url }) as any

beforeEach(() => { rpc.data = null; rpc.error = null; rpc.throws = false })

describe("GET /api/analytics/sets/directory", () => {
  it("returns rows plus echoed params, defaulting an unknown sort", async () => {
    rpc.data = [{ set_id: "s1", value_usd: 100 }]
    const res = await GET(req("https://t/api/analytics/sets/directory?sort=bogus&min_coverage=250&limit=10"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual([{ set_id: "s1", value_usd: 100 }])
    expect(body.sort).toBe("value_desc")
    expect(body.min_coverage).toBe(100) // clamped to 100
    expect(body.limit).toBe(10)
  })

  it("500s on an rpc error", async () => {
    rpc.error = { message: "db" }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("sets_directory_failed")
  })

  it("500s when the rpc throws (outer catch path)", async () => {
    rpc.throws = true
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("sets_directory_failed")
  })
})
