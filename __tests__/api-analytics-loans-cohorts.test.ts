import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/analytics/loans/cohorts — wrapper over flowty_analytics_cohorts(p_role, ...)
// via rpcWithRetry. Pins the invalid-role 400 that returns before DB, the happy
// path (role echoed + rows), and the rpc-error → 500.

const state: { data: any; error: any; throws?: boolean } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (state.throws) throw new Error("connection reset")
      return { data: state.data, error: state.error }
    },
  },
}))

import { GET } from "@/app/api/analytics/loans/cohorts/route"

const req = (u: string) => ({ url: u }) as any

beforeEach(() => { state.data = null; state.error = null; state.throws = false })

describe("GET /api/analytics/loans/cohorts", () => {
  it("400s on an invalid role before hitting the DB", async () => {
    const res = await GET(req("https://t/api/analytics/loans/cohorts?role=banker"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_role")
  })

  it("returns rows and echoes the role on the happy path", async () => {
    state.data = [{ cohort: "2026-06", count: 4 }]
    const res = await GET(req("https://t/api/analytics/loans/cohorts?role=lender"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.role).toBe("lender")
    expect(body.rows).toEqual(state.data)
  })

  it("500s with cohorts_failed on an rpc error", async () => {
    state.error = { message: "boom" }
    const res = await GET(req("https://t/api/analytics/loans/cohorts"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("cohorts_failed")
  })

  it("500s when the rpc throws (outer catch path)", async () => {
    state.throws = true
    const res = await GET(req("https://t/api/analytics/loans/cohorts"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("cohorts_failed")
  })
})
