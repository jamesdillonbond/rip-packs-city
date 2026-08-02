import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/pack-reality. Mocks
// @/lib/supabase's supabaseAdmin as a per-table thenable builder; the handler
// Promise.all's four surfaces (stats / dist / top_ev / realized). No auth guard —
// pins the empty shape, the model-vs-reality bucketing, and the 2026-08-02
// partial-degradation contract: ANY single failing leg degrades to 200 with the
// failed surface NAMED in meta.errors (it used to 500 the whole board), while an
// all-four outage is still a loud 500.

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

  // REGRESSION (2026-08-02): the stats leg used to be fatal, so a single slow
  // view rendered the whole board as "FAILED TO LOAD: HTTP 500" with every KPI
  // an em-dash even though dist / top_ev / realized were healthy.
  it("degrades to 200 and names the surface when only the stats leg errors", async () => {
    tables.topshot_pack_reality_stats = { data: null, error: { message: "stats down" } }
    tables.topshot_pack_reality_dist = { data: [{ bucket: "0", pct: 13.1 }], error: null }
    tables.topshot_pack_reality_top_ev = { data: [{ pack_listing_id: "p1", pack_ev: 3 }], error: null }
    const res = await GET(req(base))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stats).toBeNull()
    // the healthy surfaces still render
    expect(body.distribution).toHaveLength(1)
    expect(body.top_ev).toHaveLength(1)
    expect(body.meta.errors).toEqual([
      { source: "topshot_pack_reality_stats", message: "stats down" },
    ])
  })

  it("degrades to 200 when the dist and top_ev legs error", async () => {
    tables.topshot_pack_reality_stats = { data: [{ pct_zero_pulls: 51 }], error: null }
    tables.topshot_pack_reality_dist = { data: null, error: { message: "dist down" } }
    tables.topshot_pack_reality_top_ev = { data: null, error: { message: "top_ev down" } }
    const res = await GET(req(base))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stats).toEqual({ pct_zero_pulls: 51 })
    expect(body.distribution).toEqual([])
    expect(body.top_ev).toEqual([])
    expect(body.meta.errors.map((e: any) => e.source)).toEqual([
      "topshot_pack_reality_dist",
      "topshot_pack_reality_top_ev",
    ])
  })

  it("still 500s when ALL FOUR surfaces error (a silent empty board would lie)", async () => {
    tables.topshot_pack_reality_stats = { data: null, error: { message: "stats down" } }
    tables.topshot_pack_reality_dist = { data: null, error: { message: "dist down" } }
    tables.topshot_pack_reality_top_ev = { data: null, error: { message: "top_ev down" } }
    tables.v_topshot_pack_realized_ev = { data: null, error: { message: "realized down" } }
    const res = await GET(req(base))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe("stats down")
    expect(body.errors).toHaveLength(4)
  })

  it("degrades (non-fatal) when only the realized leg errors", async () => {
    tables.topshot_pack_reality_stats = { data: [{ pct_zero_pulls: 51 }], error: null }
    tables.v_topshot_pack_realized_ev = { data: null, error: { message: "realized down" } }
    const res = await GET(req(base))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stats).toEqual({ pct_zero_pulls: 51 })
    expect(body.model_vs_reality.qualifying_dists).toBe(0)
    expect(body.meta.errors.map((e: any) => e.source)).toEqual(["v_topshot_pack_realized_ev"])
  })

  it("reports no errors on a fully healthy request", async () => {
    const res = await GET(req(base))
    expect((await res.json()).meta.errors).toEqual([])
  })
})
