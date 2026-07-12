import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/analytics/loans/position-transfers — no-param wrapper over
// analytics_position_transfers_summary() via rpcWithRetry. Returns the payload
// verbatim. Pins the happy path and the rpc-error → 500.

const state: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: state.data, error: state.error }) },
}))

import { GET } from "@/app/api/analytics/loans/position-transfers/route"

beforeEach(() => { state.data = null; state.error = null })

describe("GET /api/analytics/loans/position-transfers", () => {
  it("returns the RPC payload verbatim", async () => {
    state.data = { totals: { total_transfers: 42 }, recent: [] }
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(state.data)
  })

  it("500s with position_transfers_failed on an rpc error", async () => {
    state.error = { message: "boom" }
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("position_transfers_failed")
  })
})
