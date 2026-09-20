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

  // ── ranker_staleness (#118), added 2026-09-20 with the adjudication ─────────
  // This leg had NO test at all, which is how "N packs would otherwise qualify"
  // stayed an unchecked counterfactual: the view counted rows passing the stored
  // filters and the copy asserted they would qualify if only our data were fresh.
  // Measured the day this shipped: 3 candidates, 2 still qualifying — dist 7812
  // had moved +7.73 -> -1.68 since August, so the board overstated by one in the
  // direction that flatters a buy.
  it("carries the adjudicated count AND whether the verdict was complete", async () => {
    tables.v_topshot_pack_reality_ranker_staleness = {
      data: [{
        qualifying_ignoring_freshness: 2,
        newest_qualifying_snapshot: "2026-08-28T10:07:13.756Z",
        candidates_considered: 3,
        candidates_adjudicated: 3,
      }],
      error: null,
    }
    const res = await GET(req(base))
    const body = await res.json()
    const s = body.meta.ranker_staleness
    expect(s.stale_count).toBe(2)
    expect(s.candidates_considered).toBe(3)
    expect(s.candidates_adjudicated).toBe(3)
    expect(s.verdict_complete).toBe(true)
  })

  it("reports verdict_complete false when the view hit its recomputation cap", async () => {
    // considered > adjudicated: the live re-check stopped at the cap, so the count
    // is a LOWER BOUND. A caller with no way to tell this from a complete verdict
    // would publish a floor as a total.
    tables.v_topshot_pack_reality_ranker_staleness = {
      data: [{
        qualifying_ignoring_freshness: 60,
        newest_qualifying_snapshot: "2026-09-20T00:00:00.000Z",
        candidates_considered: 214,
        candidates_adjudicated: 60,
      }],
      error: null,
    }
    const res = await GET(req(base))
    const body = await res.json()
    expect(body.meta.ranker_staleness.verdict_complete).toBe(false)
  })

  // ⚠ THE ABSENCE ARM, and it is the one that matters. Against a view that has
  // not been migrated yet the two columns are missing, and `verdict_complete`
  // must be NULL — "unknown" — never `true`. A missing field defaulting to the
  // reassuring value is this panel's entire defect class.
  it("a pre-migration view shape yields verdict_complete null, never true", async () => {
    tables.v_topshot_pack_reality_ranker_staleness = {
      data: [{ qualifying_ignoring_freshness: 3, newest_qualifying_snapshot: "2026-08-28T10:07:13.756Z" }],
      error: null,
    }
    const res = await GET(req(base))
    const body = await res.json()
    const s = body.meta.ranker_staleness
    expect(s.stale_count).toBe(3)
    expect(s.verdict_complete).toBeNull()
    expect(s.candidates_considered).toBeNull()
  })

  // A failed read must not become a zero: null, so the client keeps the old copy.
  it("a failed staleness read leaves ranker_staleness null rather than a 0 count", async () => {
    tables.v_topshot_pack_reality_ranker_staleness = { data: null, error: { message: "boom" } }
    const res = await GET(req(base))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.ranker_staleness).toBeNull()
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
    // The SOURCE is named (that is what the page renders a label from); the
    // message is classified copy, never the driver's own text — meta.errors is
    // published on this anon-readable 200 response, so a raw Postgres message
    // here would be the deep-audit D3 leak.
    expect(body.meta.errors).toHaveLength(1)
    expect(body.meta.errors[0].source).toBe("topshot_pack_reality_stats")
    expect(body.meta.errors[0].message).not.toContain("stats down")
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
    // Still loud, but classified: no driver text, and a stable machine code.
    // The per-source detail stays in the SERVER log (noteError console.errors
    // each leg); it is deliberately not published on the failure body.
    expect(body.error).not.toContain("stats down")
    expect(body.code).toBe("internal")
    expect(body.retryable).toBe(false)
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

  it("clamps a non-numeric ?limit to the default (never NaN → blank top-EV board)", async () => {
    const res = await GET(req(`${base}?limit=abc`))
    expect(res.status).toBe(200)
    // With the `?? "10"` bug the limit is NaN, which JSON-serializes to null and
    // reaches .limit(NaN) → a silently blank top-EV leg; `|| 10` yields the default.
    expect((await res.json()).meta.filters.limit).toBe(10)
  })
})
