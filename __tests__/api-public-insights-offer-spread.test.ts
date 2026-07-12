import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/offer-spread. Mocks
// @/lib/supabase's supabaseAdmin as a per-table thenable builder over
// topshot_offer_ask_spread. Pins the tier / min_ask / sort 400 guards, the
// happy/empty path with echoed filters, and the rpc-error → 500 path.

const tables: Record<string, { data: any; error: any }> = {}

vi.mock("@/lib/supabase", () => {
  const make = (table: string) => {
    const payload = () => tables[table] ?? { data: [], error: null }
    const b: any = {
      select: () => b, eq: () => b, gte: () => b, gt: () => b, lte: () => b,
      lt: () => b, ilike: () => b, order: () => b, limit: () => b, in: () => b,
      then: (resolve: any) => resolve(payload()),
    }
    return b
  }
  const admin: any = { from: (t: string) => make(t), rpc: async () => ({ data: null, error: null }) }
  return { supabaseAdmin: admin, supabase: admin }
})

import { GET } from "@/app/api/public/insights/offer-spread/route"

const req = (u: string) => ({ url: u, nextUrl: new URL(u) }) as any
const base = "https://t/api/public/insights/offer-spread"

beforeEach(() => { for (const k of Object.keys(tables)) delete tables[k] })

describe("GET /api/public/insights/offer-spread", () => {
  it("400s on an invalid tier", async () => {
    const res = await GET(req(`${base}?tier=SUPER`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("tier must be one of")
  })

  it("400s on a negative min_ask", async () => {
    const res = await GET(req(`${base}?min_ask=-1`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("min_ask must be a non-negative number")
  })

  it("400s on an invalid sort", async () => {
    const res = await GET(req(`${base}?sort=bogus`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("sort must be one of")
  })

  it("returns rows with echoed filters on the happy path", async () => {
    tables.topshot_offer_ask_spread = { data: [{ external_id: "1:2", highest_offer: 10, low_ask: 12 }], error: null }
    const res = await GET(req(`${base}?tier=rare&bid_meets_ask=true&sort=spread&limit=20`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toHaveLength(1)
    expect(body.meta.total_rows).toBe(1)
    expect(body.meta.filters).toMatchObject({ tier: "RARE", bid_meets_ask: true, sort: "spread", limit: 20 })
  })

  it("500s on a view query error", async () => {
    tables.topshot_offer_ask_spread = { data: null, error: { message: "spread down" } }
    const res = await GET(req(base))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("spread down")
  })
})
