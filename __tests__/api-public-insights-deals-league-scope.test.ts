import { describe, it, expect, beforeEach, vi } from "vitest"

/**
 * /api/public/insights/deals?property=<slug> (2026-11-26) — the Below-FMV board narrowed to one Panini or
 * Candy league / brand.
 * - an unknown slug, or a slug on a collection with no leagues, is a 400 — never the whole collection;
 * - a failed lookup is the board's unavailable response, never an unscoped board;
 * - Panini rows are re-checked on the exact product id (LIKE's `_` is a wildcard);
 * - Candy's leg is read whole and a filled window is refused, not served short.
 */

const h = vi.hoisted(() => ({ tables: {} as Record<string, { data: unknown; error: unknown }>, rpc: { data: null as unknown, error: null as unknown }, ors: [] as string[], limits: [] as number[] }))

vi.mock("@/lib/supabase", () => {
  const make = (table: string) => {
    const b: Record<string, unknown> = {}
    for (const m of ["select", "eq", "neq", "gte", "ilike", "order"]) b[m] = () => b
    b.or = (expr: string) => { h.ors.push(expr); return b }
    b.limit = (n: number) => { if (table === "cross_collection_deals_board") h.limits.push(n); return b }
    b.then = (resolve: (v: unknown) => void) => resolve(h.tables[table] ?? { data: [], error: null })
    return b
  }
  const admin = { from: (t: string) => make(t), rpc: async () => h.rpc }
  return { supabaseAdmin: admin, supabase: admin }
})
vi.mock("@/lib/insights/mv-freshness", () => ({ readDealsAsOf: async () => null }))

import { GET } from "@/app/api/public/insights/deals/route"

const req = (q: string) => ({ url: `https://t/api/public/insights/deals?${q}`, nextUrl: new URL(`https://t/api/public/insights/deals?${q}`) }) as never
const deal = (external_id: string, set_name: string) => ({ external_id, set_name, player_name: "P", discount_pct: 20, collection_slug: "x" })

beforeEach(() => { h.tables = {}; h.rpc = { data: null, error: null }; h.ors.length = 0; h.limits.length = 0 })

describe("deals board — league / brand scope", () => {
  it("Panini: narrows at the source and re-checks the exact product id", async () => {
    h.rpc = { data: [2332], error: null }
    h.tables.cross_collection_deals_board = { data: [deal("packcard-2332_1_2_3", "Base"), deal("packcard-23329_1_2_3", "Base")], error: null }
    const res = await GET(req("collection=panini_blockchain&property=fifa-world-cup"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows.map((r: { external_id: string }) => r.external_id)).toEqual(["packcard-2332_1_2_3"])
    expect(h.ors).toEqual(["external_id.like.packcard-2332_*"])
    expect(body.meta.filters.property).toBe("fifa-world-cup")
  })
  it("Candy: keeps only the brand's collections, in the board's order, up to the limit", async () => {
    h.tables.candy_collections = { data: [{ name: "Batman (1940-2011) #1" }, { name: "Superman (1939-2011) #1" }], error: null }
    h.tables.cross_collection_deals_board = { data: [deal("aaron-judge", "2026 MLB Base Series ICONs"), deal("batman-1", "Batman (1940-2011) #1"), deal("superman-1", "Superman (1939-2011) #1")], error: null }
    const res = await GET(req("collection=candy_mlb&property=dc&limit=1"))
    expect(res.status).toBe(200)
    expect((await res.json()).rows.map((r: { external_id: string }) => r.external_id)).toEqual(["batman-1"])
    expect(h.limits).toEqual([1000]) // the leg is read whole, then narrowed
  })
  it("an unknown or misplaced league is a 400 with no rows", async () => {
    h.rpc = { data: [], error: null }
    for (const q of ["collection=panini_blockchain&property=no-such", "collection=nba_top_shot&property=nba", "property=nba", "collection=candy_mlb&property=nba", "collection=panini_blockchain&property=" + encodeURIComponent("nba;x")]) {
      const res = await GET(req(q))
      expect(res.status, q).toBe(400)
      expect(await res.json(), q).not.toHaveProperty("rows")
    }
  })
  it("a failed lookup, or a Candy window that filled, is unavailable — never an unscoped or short board", async () => {
    h.rpc = { data: null, error: { message: "boom", code: "57014" } }
    const a = await GET(req("collection=panini_blockchain&property=nba"))
    expect(a.status).toBeGreaterThanOrEqual(500)
    expect(await a.json()).not.toHaveProperty("rows")
    h.tables.candy_collections = { data: null, error: { message: "boom" } }
    expect((await GET(req("collection=candy_mlb&property=dc"))).status).toBeGreaterThanOrEqual(500)
    h.tables.candy_collections = { data: [{ name: "Batman (1940-2011) #1" }], error: null }
    h.tables.cross_collection_deals_board = { data: Array.from({ length: 1000 }, (_, i) => deal(`e${i}`, "Batman (1940-2011) #1")), error: null }
    const c = await GET(req("collection=candy_mlb&property=dc"))
    expect(c.status).toBeGreaterThanOrEqual(500)
    expect(await c.json()).not.toHaveProperty("rows")
  })
  it("without the parameter nothing changes", async () => {
    h.tables.cross_collection_deals_board = { data: [deal("a", "S")], error: null }
    const res = await GET(req("collection=candy_mlb&limit=5"))
    expect((await res.json()).rows).toHaveLength(1)
    expect(h.limits).toEqual([5])
    expect(h.ors).toEqual([])
  })
})
