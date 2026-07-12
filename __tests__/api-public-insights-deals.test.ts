import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/deals. Mocks @/lib/supabase's
// supabaseAdmin as a per-table thenable builder over cross_collection_deals_board.
// Pins the several param guards (collection/confidence/min_discount/sort → 400),
// the happy/empty path, and the rpc-error → 500 path.

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

import { GET } from "@/app/api/public/insights/deals/route"

const req = (u: string) => ({ url: u, nextUrl: new URL(u) }) as any
const base = "https://t/api/public/insights/deals"

beforeEach(() => { for (const k of Object.keys(tables)) delete tables[k] })

describe("GET /api/public/insights/deals", () => {
  it("400s on an invalid collection", async () => {
    const res = await GET(req(`${base}?collection=bogus`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("collection must be one of")
  })

  it("400s on an invalid confidence", async () => {
    const res = await GET(req(`${base}?confidence=SORTA`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("confidence must be one of")
  })

  it("400s on a negative min_discount", async () => {
    const res = await GET(req(`${base}?min_discount=-5`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("min_discount must be a non-negative number")
  })

  it("400s on an invalid sort", async () => {
    const res = await GET(req(`${base}?sort=bogus`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("sort must be one of")
  })

  it("returns rows with echoed filters on the happy path", async () => {
    tables.cross_collection_deals_board = { data: [{ external_id: "73:2785", discount_pct: 22 }], error: null }
    const res = await GET(req(`${base}?collection=nba_top_shot&confidence=HIGH&sort=fmv&limit=10`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toHaveLength(1)
    expect(body.meta.total_rows).toBe(1)
    expect(body.meta.filters).toMatchObject({ collection: "nba_top_shot", confidence: "HIGH", sort: "fmv", limit: 10 })
  })

  it("500s on a view query error", async () => {
    tables.cross_collection_deals_board = { data: null, error: { message: "board down" } }
    const res = await GET(req(base))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("board down")
  })
})
