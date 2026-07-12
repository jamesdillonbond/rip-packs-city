import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/recent-sales (GET, public, no pre-DB guard).
// Mocks the @supabase/supabase-js createClient seam: a thenable query builder
// resolves the terminal sales query and .maybeSingle() the optional edition
// lookup. getCollection / COLLECTION_UUID_BY_SLUG stay real (pure). Pins the
// mapped happy path (defaults to nba-top-shot) and the query-error → 500.

const state: { sales: { data: any; error: any }; edition: { data: any } } = {
  sales: { data: [], error: null },
  edition: { data: null },
}

vi.mock("@supabase/supabase-js", () => {
  const b: any = {
    select: () => b,
    eq: () => b,
    order: () => b,
    limit: () => b,
    maybeSingle: async () => state.edition,
    then: (resolve: any) => resolve(state.sales),
  }
  return { createClient: () => ({ from: () => b }) }
})

import { GET } from "@/app/api/recent-sales/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.sales = { data: [], error: null }
  state.edition = { data: null }
})

describe("GET /api/recent-sales", () => {
  it("maps sales rows and defaults collectionId to nba-top-shot", async () => {
    state.sales = {
      data: [
        {
          serial_number: 7,
          price_usd: 42,
          sold_at: "2026-07-12T00:00:00Z",
          marketplace: "topshot",
          nft_id: "n1",
          edition_id: "e1",
          editions: { external_id: "73:2785" },
        },
      ],
      error: null,
    }
    const res = await GET(req("https://t/api/recent-sales"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.collectionId).toBe("nba-top-shot")
    expect(body.sales).toHaveLength(1)
    expect(body.sales[0]).toMatchObject({
      serialNumber: 7,
      price: 42,
      marketplace: "topshot",
      editionKey: "73:2785",
    })
  })

  it("500s on a sales query error", async () => {
    state.sales = { data: null, error: { message: "Database query failed" } }
    const res = await GET(req("https://t/api/recent-sales?collectionId=nba-top-shot"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Database query failed")
  })
})
