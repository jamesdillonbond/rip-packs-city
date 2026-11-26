import { describe, it, expect, beforeEach, vi } from "vitest"

/**
 * /api/public/insights/top-sales?property=<slug> (2026-11-26) — the Top Sales board narrowed to one Panini
 * or Candy league / brand.
 * - unknown / misplaced slug → 400; failed lookup → unavailable; never the whole collection under a league;
 * - Panini reads its own view narrowed by product id and re-checks the id exactly;
 * - Candy reads insights_top_sales_for_candy_property (the view's rows for that brand), not the whole view.
 */

const h = vi.hoisted(() => ({
  tables: {} as Record<string, { data: unknown; error: unknown; count?: number }>,
  rpcs: {} as Record<string, { data: unknown; error: unknown }>,
  from: [] as string[], rpc: [] as Array<[string, unknown]>, ors: [] as string[],
}))

vi.mock("@/lib/supabase", () => {
  const chain = (res: () => { data: unknown; error: unknown }) => {
    const b: Record<string, unknown> = {}
    for (const m of ["select", "eq", "neq", "gte", "order", "limit", "in"]) b[m] = () => b
    b.or = (expr: string) => { h.ors.push(expr); return b }
    b.then = (resolve: (v: unknown) => void) => resolve(res())
    return b
  }
  const admin = {
    from: (t: string) => { h.from.push(t); return chain(() => h.tables[t] ?? { data: [], error: null }) },
    rpc: (fn: string, args: unknown) => { h.rpc.push([fn, args]); return chain(() => h.rpcs[fn] ?? { data: [], error: null }) },
  }
  return { supabaseAdmin: admin, supabase: admin }
})
vi.mock("@/lib/username-resolver", () => ({ resolveUsernames: async () => new Map(), displayName: (a: string) => a }))

import { GET } from "@/app/api/public/insights/top-sales/route"

const req = (q: string) => ({ url: `https://t/api/public/insights/top-sales?${q}`, nextUrl: new URL(`https://t/api/public/insights/top-sales?${q}`) }) as never
const sale = (external_id: string, collection: string, price: number) => ({ sale_id: external_id, external_id, collection, price_usd: price, sold_at: "2026-11-25T00:00:00Z", buyer_address: null, seller_address: null, player_name: "P", set_name: "S" })

beforeEach(() => { h.tables = {}; h.rpcs = {}; h.from.length = 0; h.rpc.length = 0; h.ors.length = 0 })

describe("top sales — league / brand scope", () => {
  it("Panini: its own view, narrowed by product id and re-checked exactly", async () => {
    h.rpcs.panini_property_set_ids = { data: [155], error: null }
    h.tables.v_panini_top_sales = { data: [sale("packcard-155_1_2_3", "panini_blockchain", 900), sale("packcard-1551_1_2_3", "panini_blockchain", 950)], error: null }
    const res = await GET(req("collection=panini_blockchain&property=nba"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows.map((r: { external_id: string }) => r.external_id)).toEqual(["packcard-155_1_2_3"])
    expect(h.ors).toEqual(["external_id.like.packcard-155_*"])
    expect(h.from).not.toContain("v_insights_top_sales")
    expect(body.meta.filters.property).toBe("nba")
  })
  it("Candy: the brand's rows come from the brand function, not the whole view", async () => {
    h.tables.publisher_properties = { data: [{ slug: "dc" }], error: null }
    h.rpcs.insights_top_sales_for_candy_property = { data: [sale("batman-1", "candy_mlb", 500)], error: null }
    h.tables.v_insights_top_sales = { data: [sale("aaron-judge", "candy_mlb", 800)], error: null }
    const res = await GET(req("collection=candy_mlb&property=dc"))
    expect(res.status).toBe(200)
    expect((await res.json()).rows.map((r: { external_id: string }) => r.external_id)).toEqual(["batman-1"])
    expect(h.rpc).toContainEqual(["insights_top_sales_for_candy_property", { p_slug: "dc" }])
    expect(h.from).not.toContain("v_insights_top_sales")
  })
  it("an unknown or misplaced league is a 400 with no rows", async () => {
    h.rpcs.panini_property_set_ids = { data: [], error: null }
    h.tables.publisher_properties = { data: [], error: null }
    for (const q of ["collection=panini_blockchain&property=no-such", "collection=candy_mlb&property=nba", "collection=nba_top_shot&property=nba", "property=nba"]) {
      const res = await GET(req(q))
      expect(res.status, q).toBe(400)
      expect(await res.json(), q).not.toHaveProperty("rows")
    }
  })
  it("a failed lookup is unavailable, never an unscoped board", async () => {
    h.rpcs.panini_property_set_ids = { data: null, error: { message: "boom", code: "57014" } }
    h.tables.v_panini_top_sales = { data: [sale("packcard-155_1_2_3", "panini_blockchain", 900)], error: null }
    const a = await GET(req("collection=panini_blockchain&property=nba"))
    expect(a.status).toBeGreaterThanOrEqual(500)
    expect(await a.json()).not.toHaveProperty("rows")
    h.tables.publisher_properties = { data: null, error: { message: "boom" } }
    expect((await GET(req("collection=candy_mlb&property=dc"))).status).toBeGreaterThanOrEqual(500)
  })
  it("without the parameter Candy reads the whole view as before", async () => {
    h.tables.v_insights_top_sales = { data: [sale("aaron-judge", "candy_mlb", 800)], error: null }
    const res = await GET(req("collection=candy_mlb"))
    expect((await res.json()).rows).toHaveLength(1)
    expect(h.rpc.map((c) => c[0])).not.toContain("insights_top_sales_for_candy_property")
  })
})
