import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * GET /api/candy-properties (2026-11-26) — the Candy Market tab's league / brand chips.
 * A failed board read is a 5xx, never an empty index (which would silently drop the bar and un-filter a
 * scoped tab); only brands with a live ask are offered.
 */

const h = vi.hoisted(() => ({ res: null as unknown }))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/candy/properties", () => ({ readCandyPropertyBoard: async () => h.res }))

import { GET } from "@/app/api/candy-properties/route"
import { toScopeIndex } from "@/lib/panini/scope"
import { isPublicPath } from "@/proxy"

const tile = (slug: string, name: string, listed: number) => ({ slug, name, heading: slug === "dc" ? "entertainment" : "leagues", sort_order: 10, collections: 3, listed_editions: listed })

beforeEach(() => { h.res = null })

describe("GET /api/candy-properties", () => {
  it("offers the brands with a live ask, in the shape the scope bar parses", async () => {
    h.res = { ok: true, board: { properties: [tile("mlb", "MLB", 1250), tile("dc", "DC", 557), tile("sex-pistols", "Sex Pistols", 0)], setProperty: {}, unplacedCollections: 2 } }
    const res = await GET()
    expect(res.status).toBe(200)
    const index = toScopeIndex(await res.json())!
    expect(index.properties.map((p) => p.slug)).toEqual(["mlb", "dc"])
    expect(index.properties[1].heading).toBe("entertainment")
  })
  it("a failed read is a server error with no index", async () => {
    h.res = { ok: false, board: null }
    const res = await GET()
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(toScopeIndex(await res.json())).toBeNull()
  })
  it("is anon-public for GET only", () => {
    expect(isPublicPath("/api/candy-properties", "GET")).toBe(true)
    expect(isPublicPath("/api/candy-properties", "POST")).toBe(false)
  })
})
