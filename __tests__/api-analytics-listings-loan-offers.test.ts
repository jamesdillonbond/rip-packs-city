import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/analytics/listings/loan-offers — wrapper over
// analytics_listings_open_loan_offers(...) via rpcWithRetry. parseSort/parseLimit
// run for real; the happy path asserts the echoed (validated) sort and the rows
// envelope, plus rpc-error → 500.

const state: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: state.data, error: state.error }) },
}))

import { GET } from "@/app/api/analytics/listings/loan-offers/route"

const req = (u: string) => ({ url: u }) as any

beforeEach(() => { state.data = null; state.error = null })

describe("GET /api/analytics/listings/loan-offers", () => {
  it("returns rows and echoes a valid sort", async () => {
    state.data = [{ id: "l1", apr: 12 }]
    const res = await GET(req("https://t/api/analytics/listings/loan-offers?sort=apr_asc"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual(state.data)
    expect(body.sort).toBe("apr_asc")
  })

  it("falls back to apr_desc for an invalid sort", async () => {
    state.data = []
    const body = await (await GET(req("https://t/api/analytics/listings/loan-offers?sort=bogus"))).json()
    expect(body.sort).toBe("apr_desc")
    expect(body.rows).toEqual([])
  })

  it("500s with loan_offers_failed on an rpc error", async () => {
    state.error = { message: "boom" }
    const res = await GET(req("https://t/api/analytics/listings/loan-offers"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("loan_offers_failed")
  })
})
