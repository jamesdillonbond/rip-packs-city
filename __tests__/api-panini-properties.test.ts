import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * GET /api/panini-properties — the league / brand index behind the Panini scope bar and every League pill row.
 * 2026-11-27: it offered WWE and Collegiate, which are in Panini's product catalogue but RPC has never seen a
 * card of. Picking one emptied every tab and its "values and sales" link went to a 404. Only leagues with at
 * least one card are offered now; a failed read of that count is a 5xx, never a silently wider index.
 */

const h = vi.hoisted(() => ({ tables: {} as Record<string, { data: unknown; error: unknown }>, board: null as unknown }))
vi.mock("@/lib/supabase", () => {
  const chain = (name: string) => {
    const q: Record<string, unknown> = {}
    for (const m of ["select", "eq", "not", "order", "range"]) q[m] = () => q
    q.then = (ok: (v: unknown) => unknown) => Promise.resolve(h.tables[name] ?? { data: [], error: null }).then(ok)
    return q
  }
  return { supabaseAdmin: { from: (n: string) => chain(n) } }
})
vi.mock("@/lib/panini/properties", () => ({ readPaniniPropertyBoard: async () => h.board }))

import { GET } from "@/app/api/panini-properties/route"
import { toScopeIndex } from "@/lib/panini/scope"

const prop = (slug: string, name: string, sort_order: number) => ({ slug, name, heading: "leagues", sort_order })
const tile = (slug: string, editions: number) => ({ slug, name: slug, editions })

beforeEach(() => {
  h.tables = {
    publisher_properties: { data: [prop("nba", "NBA", 1), prop("wwe", "WWE", 2), prop("nfl", "NFL", 3), prop("golf", "Golf", 4)], error: null },
    panini_products: { data: [{ set_id: 155, property_slug: "nba" }, { set_id: 2065, property_slug: "wwe" }, { set_id: 1940, property_slug: "nfl" }], error: null },
  }
  h.board = { ok: true, board: { properties: [tile("nba", 11000), tile("wwe", 0), tile("nfl", 9000)], productProperty: {}, unplacedProducts: 0 } }
})

describe("GET /api/panini-properties", () => {
  it("offers only leagues that have a product AND a card RPC has seen", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const index = toScopeIndex(await res.json())!
    // wwe: products but no cards. golf: no product at all.
    expect(index.properties.map((p) => p.slug)).toEqual(["nba", "nfl"])
    expect(index.setProperty["155"]).toBe("nba")
  })
  it("a failed card-count read is a server error, never the wider index", async () => {
    h.board = { ok: false, board: null }
    const res = await GET()
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(toScopeIndex(await res.json())).toBeNull()
  })
  it("a failed catalogue read is a server error too", async () => {
    h.tables.panini_products = { data: null, error: { message: "boom" } }
    expect((await GET()).status).toBeGreaterThanOrEqual(500)
  })
})
