import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/analytics/health — no-param wrapper over analytics_pipeline_health() via
// rpcWithRetry. Pins the verbatim payload happy path and the rpc-error → 500.

const state: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: state.data, error: state.error }) },
}))

import { GET } from "@/app/api/analytics/health/route"

beforeEach(() => { state.data = null; state.error = null })

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
})
