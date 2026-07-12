import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/market-sparklines (GET). No auth. Mocks
// @supabase/supabase-js createClient (thenable builder on fmv_snapshots).
// Pins the empty-editionIds guard and the group-by-edition sparkline build.

const state: { data: any } = { data: [] }

vi.mock("@supabase/supabase-js", () => {
  const b: any = {
    select: () => b,
    in: () => b,
    gte: () => b,
    order: async () => ({ data: state.data }),
  }
  return { createClient: () => ({ from: () => b }) }
})

import { GET } from "@/app/api/market-sparklines/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.data = []
})

describe("GET /api/market-sparklines", () => {
  it("returns an empty map when no editionIds provided", async () => {
    const res = await GET(req("https://t/api/market-sparklines"))
    expect(res.status).toBe(200)
    expect((await res.json()).sparklines).toEqual({})
  })

  it("returns an empty map when editionIds is only commas", async () => {
    const res = await GET(req("https://t/api/market-sparklines?editionIds=,,"))
    expect((await res.json()).sparklines).toEqual({})
  })

  it("groups fmv points into per-edition sparkline arrays", async () => {
    state.data = [
      { edition_id: "u1", fmv_usd: 10, computed_at: "2026-07-01T00:00:00Z" },
      { edition_id: "u1", fmv_usd: 12, computed_at: "2026-07-02T00:00:00Z" },
      { edition_id: "u2", fmv_usd: 5, computed_at: "2026-07-01T00:00:00Z" },
    ]
    const res = await GET(req("https://t/api/market-sparklines?editionIds=u1,u2"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sparklines.u1).toEqual([10, 12])
    expect(body.sparklines.u2).toEqual([5])
  })
})
