import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/analytics/packs/top-ev. No hard guard
// (bad params clamp to defaults) so this covers the happy/empty path plus the
// rpc-error 500. Asserts the wrapper shape: { rows, min_price, max_price,
// min_unopened, min_coverage, direction } and that an out-of-set direction
// falls back to "pumping".

const rpc: { data: any; error: any; throws?: boolean } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (rpc.throws) throw new Error("connection reset")
      return { data: rpc.data, error: rpc.error }
    },
  },
}))

import { GET } from "@/app/api/analytics/packs/top-ev/route"

const req = (url = "https://t/api/analytics/packs/top-ev") => ({ url }) as any

beforeEach(() => { rpc.data = null; rpc.error = null; rpc.throws = false })

describe("GET /api/analytics/packs/top-ev", () => {
  it("returns rows plus echoed params, defaulting bad direction to pumping", async () => {
    rpc.data = [{ id: "p1", ev: 12 }]
    const res = await GET(req("https://t/api/analytics/packs/top-ev?direction=sideways&limit=5"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual([{ id: "p1", ev: 12 }])
    expect(body.direction).toBe("pumping")
    expect(body.min_price).toBe(1)
    expect(body.max_price).toBe(5000)
  })

  it("returns an empty rows array when the rpc yields null", async () => {
    rpc.data = null
    const body = await (await GET(req())).json()
    expect(body.rows).toEqual([])
  })

  it("500s on an rpc error", async () => {
    rpc.error = { message: "db" }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("packs_top_ev_failed")
  })

  it("500s when the rpc throws (outer catch path)", async () => {
    rpc.throws = true
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("packs_top_ev_failed")
  })
})
