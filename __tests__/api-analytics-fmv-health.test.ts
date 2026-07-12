import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/analytics/fmv/health — no-param wrapper over analytics_fmv_pipeline_health()
// via rpcWithRetry. Pins the happy path (RPC payload returned verbatim) and the
// rpc-error → 500 with the fixed error code.

const state: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: state.data, error: state.error }) },
}))

import { GET } from "@/app/api/analytics/fmv/health/route"

beforeEach(() => { state.data = null; state.error = null })

describe("GET /api/analytics/fmv/health", () => {
  it("returns the RPC payload verbatim", async () => {
    state.data = { collections: { nba_top_shot: { reliable: 10 } } }
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(state.data)
  })

  it("500s with fmv_health_failed on an rpc error", async () => {
    state.error = { message: "db down" }
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("fmv_health_failed")
  })
})
