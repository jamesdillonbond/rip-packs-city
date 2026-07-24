import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/analytics/loans/limbo-summary — wrapper over flowty_analytics_limbo_summary(
// p_collections) via rpcWithRetry. Returns the RPC payload verbatim. Pins the
// happy path and the rpc-error → 500.

const state: { data: any; error: any; throws?: boolean } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (state.throws) throw new Error("connection reset")
      return { data: state.data, error: state.error }
    },
  },
}))

import { GET } from "@/app/api/analytics/loans/limbo-summary/route"

const req = (u: string) => ({ url: u }) as any

beforeEach(() => { state.data = null; state.error = null; state.throws = false })

describe("GET /api/analytics/loans/limbo-summary", () => {
  it("returns the RPC payload verbatim", async () => {
    state.data = { limbo_count: 12, limbo_principal_usd: 3400 }
    const res = await GET(req("https://t/api/analytics/loans/limbo-summary"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(state.data)
  })

  it("500s with limbo_summary_failed on an rpc error", async () => {
    state.error = { message: "boom" }
    const res = await GET(req("https://t/api/analytics/loans/limbo-summary"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("limbo_summary_failed")
  })

  it("500s when the rpc throws (outer catch path)", async () => {
    state.throws = true
    const res = await GET(req("https://t/api/analytics/loans/limbo-summary"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("limbo_summary_failed")
  })
})
