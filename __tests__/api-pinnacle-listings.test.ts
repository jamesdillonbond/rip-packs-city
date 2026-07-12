import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/pinnacle/listings (no auth). Mocks
// @/lib/supabase's `supabase`: a thenable builder chain over pinnacle_editions
// (select/in/eq/order/range) then a floor-price lookup on pinnacle_sales.
// Pins the empty path, the floor-price merge happy path, and error -> 500.

const tables: Record<string, { data: any; error?: any; count?: any }> = {}

vi.mock("@/lib/supabase", () => {
  const builder = (table: string) => {
    const payload = () => tables[table] ?? { data: [], error: null, count: 0 }
    const b: any = {
      select: () => b,
      in: () => b,
      eq: () => b,
      order: () => b,
      range: () => b,
      then: (resolve: any) => resolve(payload()),
    }
    return b
  }
  return { supabase: { from: (t: string) => builder(t) } }
})

import { GET } from "@/app/api/pinnacle/listings/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
})

describe("GET /api/pinnacle/listings", () => {
  it("returns an empty data set when there are no editions", async () => {
    tables.pinnacle_editions = { data: [], error: null, count: 0 }
    const res = await GET(req("https://t/api/pinnacle/listings"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual([])
    expect(body.count).toBe(0)
  })

  it("500s on an editions query error", async () => {
    tables.pinnacle_editions = { data: null, error: { message: "db down" } }
    const res = await GET(req("https://t/api/pinnacle/listings"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })

  it("merges the lowest floor price from pinnacle_sales into each edition", async () => {
    tables.pinnacle_editions = {
      data: [{ id: "e1", variant_type: "standard" }],
      error: null,
      count: 1,
    }
    tables.pinnacle_sales = {
      data: [
        { edition_id: "e1", sale_price_usd: 9 },
        { edition_id: "e1", sale_price_usd: 5 },
      ],
    }
    const res = await GET(req("https://t/api/pinnacle/listings?sortBy=price_asc"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBe(1)
    expect(body.data[0].id).toBe("e1")
    expect(body.data[0].floor_price_usd).toBe(5)
  })
})
