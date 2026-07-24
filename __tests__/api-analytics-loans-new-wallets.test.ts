import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/analytics/loans/new-wallets — wrapper over flowty_analytics_new_wallets(...)
// via rpcWithRetry. parseWindow/windowRange run for real. Pins the { rows }
// envelope on the happy/empty path and the rpc-error → 500.

const state: { data: any; error: any; throws?: boolean } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (state.throws) throw new Error("connection reset")
      return { data: state.data, error: state.error }
    },
  },
}))

import { GET } from "@/app/api/analytics/loans/new-wallets/route"

const req = (u: string) => ({ url: u }) as any

beforeEach(() => { state.data = null; state.error = null; state.throws = false })

describe("GET /api/analytics/loans/new-wallets", () => {
  it("wraps the RPC rows in a { rows } envelope (window respected)", async () => {
    state.data = [{ bucket: "2026-07-01", new_wallets: 7 }]
    const res = await GET(req("https://t/api/analytics/loans/new-wallets?window=l30"))
    expect(res.status).toBe(200)
    expect((await res.json()).rows).toEqual(state.data)
  })

  it("returns an empty rows array when the RPC returns null", async () => {
    state.data = null
    const res = await GET(req("https://t/api/analytics/loans/new-wallets"))
    expect(res.status).toBe(200)
    expect((await res.json()).rows).toEqual([])
  })

  it("500s with new_wallets_failed on an rpc error", async () => {
    state.error = { message: "boom" }
    const res = await GET(req("https://t/api/analytics/loans/new-wallets"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("new_wallets_failed")
  })

  it("500s when the rpc throws (outer catch path)", async () => {
    state.throws = true
    const res = await GET(req("https://t/api/analytics/loans/new-wallets"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("new_wallets_failed")
  })
})
