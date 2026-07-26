import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/allday-pack-market. Mocks
// @/lib/supabase's supabaseAdmin as a per-table thenable builder (the handler
// awaits .from(v_allday_pack_market).select().gte().limit() directly). No auth
// guard — pins the happy/empty shape and the rpc-error → 500 path.

const tables: Record<string, { data: any; error: any }> = {}

vi.mock("@/lib/supabase", () => {
  const make = (table: string) => {
    const payload = () => tables[table] ?? { data: [], error: null }
    const b: any = {
      select: () => b, eq: () => b, gte: () => b, gt: () => b, lte: () => b,
      lt: () => b, ilike: () => b, order: () => b, limit: () => b, range: () => b, in: () => b,
      then: (resolve: any) => resolve(payload()),
    }
    return b
  }
  const admin: any = { from: (t: string) => make(t), rpc: async () => ({ data: null, error: null }) }
  return { supabaseAdmin: admin, supabase: admin }
})

import { GET } from "@/app/api/public/insights/allday-pack-market/route"

const req = (u = "https://t/api/public/insights/allday-pack-market") => ({ url: u, nextUrl: new URL(u) }) as any

beforeEach(() => { for (const k of Object.keys(tables)) delete tables[k] })

describe("GET /api/public/insights/allday-pack-market", () => {
  it("returns an empty-but-shaped payload when the view has no rows", async () => {
    tables.v_allday_pack_market = { data: [], error: null }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.market.qualifying_dists).toBe(0)
    expect(body.market.biggest_discount).toEqual([])
    expect(body.market.most_traded).toEqual([])
    expect(body.meta.filters.min_sales).toBe(5)
  })

  it("buckets rows into discount / premium / most-traded", async () => {
    tables.v_allday_pack_market = {
      data: [
        { dist_id: "d1", retail_price: 100, secondary_vs_retail_ratio: 0.5, n_sales: 20, last_sale_at: "2026-07-01T00:00:00Z" },
        { dist_id: "d2", retail_price: 100, secondary_vs_retail_ratio: 1.4, n_sales: 50, last_sale_at: "2026-07-05T00:00:00Z" },
        { dist_id: "d3", retail_price: 0, secondary_vs_retail_ratio: null, n_sales: 8, last_sale_at: "2026-07-03T00:00:00Z" },
      ],
      error: null,
    }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.market.qualifying_dists).toBe(3)
    expect(body.market.biggest_discount.map((r: any) => r.dist_id)).toContain("d1")
    expect(body.market.biggest_premium.map((r: any) => r.dist_id)).toContain("d2")
    expect(body.market.most_traded[0].dist_id).toBe("d2") // highest n_sales first
    expect(body.meta.last_sale_at).toBe("2026-07-05T00:00:00Z")
  })

  it("500s on a view query error", async () => {
    tables.v_allday_pack_market = { data: null, error: { message: "view down" } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("view down")
  })

  it("coerces string/blank/NaN numerics via num() and drops null-freshness rows", async () => {
    tables.v_allday_pack_market = {
      data: [
        { dist_id: "s1", retail_price: "100", secondary_vs_retail_ratio: "0.5", n_sales: "12", drop_size: "", opened_pct_of_minted: "x", last_sale_at: null },
        { dist_id: "n1", retail_price: 50, secondary_vs_retail_ratio: 1.0, n_sales: 6, last_sale_at: "2026-07-09T00:00:00Z" },
      ],
      error: null,
    }
    const res = await GET(req())
    const body = await res.json()
    const s1 = body.market.most_traded.find((r: any) => r.dist_id === "s1")
    expect(s1.drop_size).toBeNull()            // "" -> null
    expect(s1.opened_pct_of_minted).toBeNull() // NaN -> null
    expect(s1.retail_price).toBe(100)    // "100" -> 100
    expect(body.market.biggest_discount.map((r: any) => r.dist_id)).toEqual(["s1"])
    expect(body.market.biggest_premium).toEqual([]) // n1 ratio 1.0 in neither bucket
    expect(body.meta.last_sale_at).toBe("2026-07-09T00:00:00Z") // null-freshness s1 ignored
  })
})
