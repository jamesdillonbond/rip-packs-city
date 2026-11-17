import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/analytics/wallets/overview. No params, no
// guards; wraps analytics_wallets_overview() and returns the payload verbatim.
// Pins the happy pass-through and the rpc-error 500.

const rpc: { data: any; error: any; throws?: boolean } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (rpc.throws) throw new Error("connection reset")
      return { data: rpc.data, error: rpc.error }
    },
  },
}))

import { GET } from "@/app/api/analytics/wallets/overview/route"

beforeEach(() => { rpc.data = null; rpc.error = null; rpc.throws = false })

describe("GET /api/analytics/wallets/overview", () => {
  it("returns the rpc payload verbatim", async () => {
    rpc.data = { wallets: 1000, borrowers: 40, lenders: 12 }
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ wallets: 1000, borrowers: 40, lenders: 12 })
  })

  it("500s on an rpc error", async () => {
    rpc.error = { message: "db" }
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("wallets_overview_failed")
  })

  it("500s when the rpc throws (outer catch path)", async () => {
    rpc.throws = true
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("wallets_overview_failed")
  })
})
