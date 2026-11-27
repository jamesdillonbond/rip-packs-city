import { describe, it, expect, beforeEach, vi } from "vitest"

/**
 * /api/public/insights/trophies?property=<slug> (2026-11-26) — the Trophy Room narrowed to one Panini or Candy
 * league / brand.
 * - unknown / misplaced slug → 400; failed lookup → unavailable; never the whole collection under a league;
 * - Panini narrows by product-id prefix (the underscore closes the id);
 * - Candy reads insights_trophies_for_candy_property (the brand's rows), not the whole collection's.
 */

const h = vi.hoisted(() => ({
  tables: {} as Record<string, { data: unknown; error: unknown }>,
  rpcs: {} as Record<string, { data: unknown; error: unknown }>,
  rpc: [] as Array<[string, unknown]>, ors: [] as string[],
}))

vi.mock("@/lib/supabase", () => {
  const chain = (res: () => { data: unknown; error: unknown }) => {
    const b: Record<string, unknown> = {}
    for (const m of ["select", "eq", "neq", "gte", "order", "limit", "in", "not"]) b[m] = () => b
    b.or = (expr: string) => { h.ors.push(expr); return b }
    b.then = (resolve: (v: unknown) => void) => resolve(res())
    return b
  }
  const admin = {
    from: (t: string) => chain(() => h.tables[t] ?? { data: [], error: null }),
    rpc: (fn: string, args: unknown) => { h.rpc.push([fn, args]); return chain(() => h.rpcs[fn] ?? { data: [], error: null }) },
  }
  return { supabaseAdmin: admin, supabase: admin }
})

import { GET } from "@/app/api/public/insights/trophies/route"

const req = (q: string) => ({ url: `https://t/api/public/insights/trophies?${q}`, nextUrl: new URL(`https://t/api/public/insights/trophies?${q}`) }) as never
const grail = (external_id: string, collection: string) => ({ edition_id: external_id, external_id, collection, fmv_usd: 100, circulation_count: 1 })

beforeEach(() => { h.tables = {}; h.rpcs = {}; h.rpc.length = 0; h.ors.length = 0 })

describe("trophies — league / brand scope", () => {
  it("Panini: the collection's rows narrowed by product-id prefix", async () => {
    h.rpcs.panini_property_set_ids = { data: [155, 2019], error: null }
    h.rpcs.get_insights_trophies = { data: [grail("packcard-155_1_2_3", "panini_blockchain")], error: null }
    const res = await GET(req("collection=panini_blockchain&property=nba"))
    expect(res.status).toBe(200)
    expect((await res.json()).rows).toHaveLength(1)
    expect(h.ors).toEqual(["external_id.like.packcard-155_*,external_id.like.packcard-2019_*"])
    expect(h.rpc).toContainEqual(["get_insights_trophies", { p_collections: ["panini_blockchain"] }])
  })
  it("Candy: the brand's rows come from the brand function, not the whole collection", async () => {
    h.tables.publisher_properties = { data: [{ slug: "dc" }], error: null }
    h.rpcs.insights_trophies_for_candy_property = { data: [grail("batman-1", "candy_mlb")], error: null }
    h.rpcs.get_insights_trophies = { data: [grail("aaron-judge", "candy_mlb")], error: null }
    const res = await GET(req("collection=candy_mlb&property=dc"))
    expect(res.status).toBe(200)
    expect((await res.json()).rows.map((r: { external_id: string }) => r.external_id)).toEqual(["batman-1"])
    expect(h.rpc).toContainEqual(["insights_trophies_for_candy_property", { p_slug: "dc" }])
    expect(h.rpc.map((c) => c[0])).not.toContain("get_insights_trophies")
    expect(h.ors).toEqual([])
  })
  it("an unknown or misplaced league is a 400 with no rows", async () => {
    h.rpcs.panini_property_set_ids = { data: [], error: null }
    h.tables.publisher_properties = { data: [], error: null }
    h.rpcs.get_insights_trophies = { data: [grail("x", "candy_mlb")], error: null }
    for (const q of ["collection=panini_blockchain&property=no-such", "collection=candy_mlb&property=nba", "collection=nba_top_shot&property=nba", "property=nba"]) {
      const res = await GET(req(q))
      expect(res.status, q).toBe(400)
      expect(await res.json(), q).not.toHaveProperty("rows")
    }
  })
  it("a failed lookup is unavailable, never an unscoped board", async () => {
    h.rpcs.panini_property_set_ids = { data: null, error: { message: "boom", code: "57014" } }
    h.rpcs.get_insights_trophies = { data: [grail("packcard-155_1_2_3", "panini_blockchain")], error: null }
    const a = await GET(req("collection=panini_blockchain&property=nba"))
    expect(a.status).toBeGreaterThanOrEqual(500)
    expect(await a.json()).not.toHaveProperty("rows")
    h.tables.publisher_properties = { data: null, error: { message: "boom" } }
    expect((await GET(req("collection=candy_mlb&property=dc"))).status).toBeGreaterThanOrEqual(500)
  })
  it("without the parameter Candy reads the whole collection as before", async () => {
    h.rpcs.get_insights_trophies = { data: [grail("aaron-judge", "candy_mlb")], error: null }
    const res = await GET(req("collection=candy_mlb"))
    expect((await res.json()).rows).toHaveLength(1)
    expect(h.rpc.map((c) => c[0])).not.toContain("insights_trophies_for_candy_property")
    expect(h.ors).toEqual([])
  })
})
