import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/allday-pack-reality. Mocks
// @/lib/supabase's supabaseAdmin as a per-table thenable builder (the handler
// awaits .from(v_allday_pack_realized_ev).select().gte().eq().limit()). No auth
// guard — pins the empty shape, the model-vs-reality bucketing, and error → 500.

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

import { GET } from "@/app/api/public/insights/allday-pack-reality/route"

const req = (u = "https://t/api/public/insights/allday-pack-reality") => ({ url: u, nextUrl: new URL(u) }) as any

beforeEach(() => { for (const k of Object.keys(tables)) delete tables[k] })

describe("GET /api/public/insights/allday-pack-reality", () => {
  it("returns an empty-but-shaped payload when the view is sparse", async () => {
    tables.v_allday_pack_realized_ev = { data: [], error: null }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.model_vs_reality.qualifying_dists).toBe(0)
    expect(body.model_vs_reality.over_modeled).toEqual([])
    expect(body.meta.filters.min_opens).toBe(5)
    expect(body.meta.filters.exclude_low_confidence).toBe(true)
  })

  it("classifies over/under/on-model rows honestly (non-fossil guard)", async () => {
    tables.v_allday_pack_realized_ev = {
      data: [
        // over-modeled: ratio<0.6, modeled within 1.5x pack price, modeled>=2
        { dist_id: "o1", pack_price: 10, modeled_gross_ev: 12, realized_to_modeled_ratio: 0.4, n_opens: 20 },
        // under-modeled: ratio>1.8
        { dist_id: "u1", pack_price: 10, modeled_gross_ev: 5, realized_to_modeled_ratio: 2.5, n_opens: 15 },
        // on-model: ratio ~1.0
        { dist_id: "m1", pack_price: 10, modeled_gross_ev: 9, realized_to_modeled_ratio: 1.0, n_opens: 40 },
      ],
      error: null,
    }
    const res = await GET(req())
    const body = await res.json()
    expect(body.model_vs_reality.qualifying_dists).toBe(3)
    expect(body.model_vs_reality.over_modeled.map((r: any) => r.dist_id)).toContain("o1")
    expect(body.model_vs_reality.under_modeled.map((r: any) => r.dist_id)).toContain("u1")
    expect(body.model_vs_reality.on_model.map((r: any) => r.dist_id)).toContain("m1")
  })

  it("500s on a view query error", async () => {
    tables.v_allday_pack_realized_ev = { data: null, error: { message: "realized down" } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("realized down")
  })
})
