import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/analytics/health — no-param wrapper over analytics_pipeline_health() via
// rpcWithRetry. Pins the verbatim payload happy path and the rpc-error → 500.

const state: { data: any; error: any; throws?: boolean } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (state.throws) throw new Error("connection reset")
      return { data: state.data, error: state.error }
    },
  },
}))

import { GET } from "@/app/api/analytics/health/route"

beforeEach(() => { state.data = null; state.error = null; state.throws = false })

describe("GET /api/analytics/health", () => {
  it("returns the RPC payload verbatim", async () => {
    state.data = { overall_status: "green", pipelines: [] }
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(state.data)
  })

  it("500s with health_failed on an rpc error", async () => {
    state.error = { message: "db down" }
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("health_failed")
  })

  it("500s when the rpc throws (outer catch path)", async () => {
    state.throws = true
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("health_failed")
  })
})
