import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/analytics/loans/summary — wrapper over flowty_analytics_summary(...) via
// rpcWithRetry. Returns the RPC payload verbatim. Pins the happy path and the
// rpc-error → 500.

const state: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: state.data, error: state.error }) },
}))

import { GET } from "@/app/api/analytics/loans/summary/route"

const req = (u: string) => ({ url: u }) as any

beforeEach(() => { state.data = null; state.error = null })

describe("GET /api/analytics/loans/summary", () => {
  it("returns the RPC payload verbatim", async () => {
    state.data = { total_loans: 88, funded_principal_usd: 12345 }
    const res = await GET(req("https://t/api/analytics/loans/summary?window=y2026"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(state.data)
  })

  it("500s with summary_failed on an rpc error", async () => {
    state.error = { message: "boom" }
    const res = await GET(req("https://t/api/analytics/loans/summary"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("summary_failed")
  })
})
