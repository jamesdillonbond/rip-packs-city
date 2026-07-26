import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/topshot-pack-market. No param
// guards — reads the v_topshot_pack_market view (n_sales >= 5) and buckets the
// rows into biggest_discount / biggest_premium / most_traded in-handler. Pins the
// empty path, the discount/premium bucketing, and the rpc-error 500 via a
// thenable mock builder.

const state: { data: any; error: any } = { data: [], error: null }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b,
    gte: () => b,
    limit: () => b,
    order: () => b,
    range: () => b,
    then: (resolve: any) => resolve({ data: state.data, error: state.error }),
  }
  return { supabaseAdmin: { from: () => b } }
})

import { GET } from "@/app/api/public/insights/topshot-pack-market/route"

const req = () => ({ url: "https://t/api/public/insights/topshot-pack-market" }) as any

beforeEach(() => {
  state.data = []
  state.error = null
})

describe("GET /api/public/insights/topshot-pack-market", () => {
  it("returns an empty market when no dists qualify", async () => {
    state.data = []
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.market.qualifying_dists).toBe(0)
    expect(body.market.biggest_discount).toEqual([])
    expect(body.market.most_traded).toEqual([])
  })

  it("buckets discount and premium dists by secondary_vs_retail_ratio", async () => {
    state.data = [
      { dist_id: "d1", retail_price: 100, secondary_vs_retail_ratio: 0.5, n_sales: 20, last_sale_at: "2026-07-10" },
      { dist_id: "d2", retail_price: 100, secondary_vs_retail_ratio: 1.6, n_sales: 40, last_sale_at: "2026-07-11" },
    ]
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.market.qualifying_dists).toBe(2)
    expect(body.market.biggest_discount[0].dist_id).toBe("d1")
    expect(body.market.biggest_premium[0].dist_id).toBe("d2")
    expect(body.market.most_traded[0].dist_id).toBe("d2") // most n_sales first
    expect(body.meta.last_sale_at).toBe("2026-07-11")
  })

  it("500s on a query error", async () => {
    state.error = { message: "db down" }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })

  it("coerces string/blank/NaN numerics via num() and keeps premium (retail-null) dists out of the priced buckets", async () => {
    state.data = [
      // string numerics -> coerced; a real discount
      { dist_id: "s1", retail_price: "100", secondary_vs_retail_ratio: "0.5", n_sales: "12", drop_size: "", depletion_pct: "not-a-number", last_sale_at: "2026-07-01" },
      // premium pack: retail NULL + ratio NULL -> excluded from discount/premium, present in most_traded
      { dist_id: "p1", retail_price: null, secondary_vs_retail_ratio: null, n_sales: 99, last_sale_at: null },
      // priced but within [0.85,1.15] -> in neither discount nor premium bucket
      { dist_id: "n1", retail_price: 50, secondary_vs_retail_ratio: 1.0, n_sales: 5, last_sale_at: "2026-07-05" },
    ]
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.market.qualifying_dists).toBe(3)
    // blank drop_size -> null, NaN depletion_pct -> null (num() coercion)
    const s1 = body.market.most_traded.find((r: any) => r.dist_id === "s1")
    expect(s1.drop_size).toBeNull()
    expect(s1.depletion_pct).toBeNull()
    expect(s1.retail_price).toBe(100) // "100" -> 100
    // only s1 is a discount; p1 (retail null) and n1 (ratio 1.0) are excluded
    expect(body.market.biggest_discount.map((r: any) => r.dist_id)).toEqual(["s1"])
    expect(body.market.biggest_premium).toEqual([])
    // most_traded sorts by n_sales desc; premium pack p1 (99) leads
    expect(body.market.most_traded[0].dist_id).toBe("p1")
    // freshness ignores the null last_sale_at row
    expect(body.meta.last_sale_at).toBe("2026-07-05")
  })
})
