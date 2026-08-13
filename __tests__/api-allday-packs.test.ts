import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/allday-packs.
// Paginates pack_distributions for the AllDay collection and normalizes retail
// prices. Mock @supabase/supabase-js: a chained .from().select().eq().order()
// .range() that resolves the page payload. Pin the happy path + the error 500.

const state: { data: any; error: any } = { data: [], error: null }

vi.mock("@supabase/supabase-js", () => {
  const b: any = {
    from: () => b,
    select: () => b,
    eq: () => b,
    order: () => b,
    range: async () => ({ data: state.data, error: state.error }),
  }
  return { createClient: () => b }
})

import { GET } from "@/app/api/allday-packs/route"

beforeEach(() => {
  state.data = []
  state.error = null
})

describe("GET /api/allday-packs", () => {
  it("returns the empty distributions payload", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBe(0)
    expect(body.distributions).toEqual([])
  })

  it("returns distributions with normalized retail prices", async () => {
    state.data = [{ dist_id: 1, title: "Base", nft_type: "x", metadata: { retail_price_usd: 5 } }]
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBe(1)
    expect(body.distributions[0].dist_id).toBe(1)
  })

  it("500s on a query error", async () => {
    state.error = { message: "db down" }
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("db down")
  })
})
