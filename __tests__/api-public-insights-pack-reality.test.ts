import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/pack-reality. Mocks
// @/lib/supabase's supabaseAdmin as a per-table thenable builder; the handler
// Promise.all's four surfaces (stats / dist / top_ev / realized). No auth guard —
// pins the empty shape, the model-vs-reality bucketing, the fatal stats → 500,
// and the NON-fatal realized-leg degradation.

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

import { GET } from "@/app/api/public/insights/pack-reality/route"

const req = (u: string) => ({ url: u, nextUrl: new URL(u) }) as any
const base = "https://t/api/public/insights/pack-reality"

beforeEach(() => { for (const k of Object.keys(tables)) delete tables[k] })

describe("GET /api/public/insights/pack-reality", () => {
  it("returns an empty-but-shaped payload when all views are empty", async () => {
    const res = await GET(req(base))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stats).toBeNull()
    expect(body.distribution).toEqual([])
    expect(body.top_ev).toEqual([])
    expect(body.model_vs_reality.qualifying_dists).toBe(0)
  })

  it("classifies realized model-vs-reality buckets (non-fossil guard)", async () => {
    tables.topshot_pack_reality_stats = { data: [{ pct_zero_pulls: 51 }], error: null }
    tables.topshot_pack_reality_dist = { data: [{ bucket: "0", n: 100 }], error: null }
    tables.topshot_pack_reality_top_ev = { data: [{ pack_listing_id: "p1", pack_ev: 3 }], error: null }
    tables.v_topshot_pack_realized_ev = {
      data: [
        // over-modeled: ratio<0.6, modeled within 1.5x price, modeled>=10
        { dist_id: "o1", modeled_pack_price: 15, modeled_gross_ev: 20, realized_to_modeled_ratio: 0.4, n_opens: 50 },
        // under-modeled: ratio>1.8
        { dist_id: "u1", modeled_pack_price: 15, modeled_gross_ev: 5, realized_to_modeled_ratio: 2.2, n_opens: 30 },
      ],
      error: null,
    }
    const res = await GET(req(base))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stats).toEqual({ pct_zero_pulls: 51 })
    expect(body.top_ev).toHaveLength(1)
    expect(body.model_vs_reality.over_modeled.map((r: any) => r.dist_id)).toContain("o1")
    expect(body.model_vs_reality.under_modeled.map((r: any) => r.dist_id)).toContain("u1")
  })

  it("500s when the fatal stats leg errors", async () => {
    tables.topshot_pack_reality_stats = { data: null, error: { message: "stats down" } }
    const res = await GET(req(base))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("stats down")
  })

  it("degrades (non-fatal) when only the realized leg errors", async () => {
    tables.topshot_pack_reality_stats = { data: [{ pct_zero_pulls: 51 }], error: null }
    tables.v_topshot_pack_realized_ev = { data: null, error: { message: "realized down" } }
    const res = await GET(req(base))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stats).toEqual({ pct_zero_pulls: 51 })
    expect(body.model_vs_reality.qualifying_dists).toBe(0)
  })
})
