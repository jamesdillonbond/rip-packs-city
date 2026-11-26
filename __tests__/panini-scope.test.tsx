// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"

/**
 * Panini league / brand SCOPE (2026-11-26): one choice, carried as ?property= and remembered, that every Panini
 * tab filters by. Stated as the absence of false claims:
 *  - a failed index read never filters a tab and never renders an empty control; a scoped arrival says so;
 *  - a stale stored slug the index does not know is dropped (it must not hide every row);
 *  - the word "property" never renders (the control is "League or brand");
 *  - /api/panini-properties answers a failed read with an error, never an empty index.
 */

const fetchState: { ok: boolean; json: unknown } = { ok: true, json: null }
vi.mock("@/lib/analytics/fetch-json", () => ({ fetchJson: async () => ({ ok: fetchState.ok, json: fetchState.ok ? fetchState.json : null }) }))

type Res = { data: unknown; error: unknown }
const db: { props: Res; products: Res } = { props: { data: [], error: null }, products: { data: [], error: null } }
vi.mock("@/lib/supabase", () => {
  const chain = (which: "props" | "products") => {
    const q: Record<string, unknown> = {}
    for (const k of ["select", "eq", "not", "order", "range"]) q[k] = () => q
    q.then = (resolve: (v: Res) => unknown) => resolve(db[which])
    return q
  }
  return { supabaseAdmin: { from: (t: string) => chain(t === "publisher_properties" ? "props" : "products") } }
})

import {
  cleanScopeSlug, countByProperty, paniniSetIdOf, propertyOfSetId, toScopeIndex, PANINI_SCOPE_STORAGE_KEY,
} from "@/lib/panini/scope"
import PaniniScopeBar, { usePaniniScope } from "@/components/collection/PaniniScopeBar"
import { EMPTY_PANINI_CARD_FILTER, filterSortPaniniCards } from "@/lib/panini/collection-view"
import type { PaniniOwnerCard } from "@/lib/panini/owner-cards"
import { GET } from "@/app/api/panini-properties/route"

const INDEX = {
  properties: [
    { slug: "fifa-world-cup", name: "FIFA World Cup", heading: "leagues", sort_order: 10 },
    { slug: "nba", name: "NBA", heading: "leagues", sort_order: 20 },
    { slug: "bad-eggs", name: "Bad Eggs", heading: "entertainment", sort_order: 210 },
    { slug: "x", name: "X", heading: "nonsense" },
  ],
  setProperty: { "2332": "fifa-world-cup", "2120": "nba", "850130": "bad-eggs", abc: "nba", "9": 7 },
}

beforeEach(() => {
  fetchState.ok = true
  fetchState.json = INDEX
  window.localStorage.clear()
  window.history.replaceState(null, "", "/panini-blockchain/sniper")
})
afterEach(cleanup)

describe("lib/panini/scope", () => {
  it("parses the index, dropping malformed rows; a wrong shape is null", () => {
    const i = toScopeIndex(INDEX)!
    expect(i.properties.map((p) => p.slug)).toEqual(["fifa-world-cup", "nba", "bad-eggs"])
    expect(i.setProperty).toEqual({ "2332": "fifa-world-cup", "2120": "nba", "850130": "bad-eggs" })
    expect(toScopeIndex(null)).toBeNull()
    expect(toScopeIndex({ properties: [] })).toBeNull()
    expect(toScopeIndex({ properties: "x", setProperty: {} })).toBeNull()
  })
  it("reads the set id out of a card key or sku; places it; counts rows", () => {
    expect(paniniSetIdOf("packcard-2332_147_10")).toBe(2332)
    expect(paniniSetIdOf("packcard-2332_147_10__4_10")).toBe(2332)
    expect(paniniSetIdOf("pack-99")).toBeNull()
    expect(paniniSetIdOf(null)).toBeNull()
    const i = toScopeIndex(INDEX)
    expect(propertyOfSetId(i, 2120)).toBe("nba")
    expect(propertyOfSetId(i, 1)).toBeNull()
    expect(propertyOfSetId(null, 2120)).toBeNull()
    const c = countByProperty(i, [{ s: 2332 }, { s: 2332 }, { s: 2120 }, { s: 5 }, { s: null }], (r) => r.s)
    expect([...c.entries()]).toEqual([["fifa-world-cup", 2], ["nba", 1]])
    expect(countByProperty(null, [{ s: 2332 }], (r) => r.s).size).toBe(0)
  })
  it("a slug is lower-case kebab or nothing", () => {
    expect(cleanScopeSlug(" FIFA-World-Cup ")).toBe("fifa-world-cup")
    expect(cleanScopeSlug("nba; drop")).toBe("")
    expect(cleanScopeSlug(null)).toBe("")
  })
})

function Harness({ counts, total }: { counts?: Map<string, number>; total?: number }) {
  const scope = usePaniniScope()
  return (
    <div>
      <PaniniScopeBar scope={scope} counts={counts} total={total} />
      <output data-testid="slug">{scope.slug}</output>
      <output data-testid="name">{scope.name ?? ""}</output>
    </div>
  )
}

describe("usePaniniScope + PaniniScopeBar", () => {
  it("shows only leagues / brands the tab has rows for, biggest first, and never the word property", async () => {
    const counts = new Map([["nba", 5], ["fifa-world-cup", 40]])
    const c = render(<Harness counts={counts} total={45} />).container
    await waitFor(() => expect(c.querySelector('[data-testid="panini-scope-bar"]')).not.toBeNull())
    expect([...c.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["All · 45", "FIFA World Cup · 40", "NBA · 5"])
    expect(c.querySelector('[role="group"]')!.getAttribute("aria-label")).toBe("League or brand")
    expect(c.textContent).not.toMatch(/propert/i)
  })
  it("a pick is written to the URL and remembered, and clearing removes both", async () => {
    const c = render(<Harness />).container
    await waitFor(() => expect(c.querySelector('[data-testid="panini-scope-bar"]')).not.toBeNull())
    fireEvent.click([...c.querySelectorAll("button")].find((b) => b.textContent === "NBA")!)
    expect(c.querySelector('[data-testid="slug"]')!.textContent).toBe("nba")
    expect(c.querySelector('[data-testid="name"]')!.textContent).toBe("NBA")
    expect(window.location.search).toBe("?property=nba")
    expect(window.localStorage.getItem(PANINI_SCOPE_STORAGE_KEY)).toBe("nba")
    fireEvent.click([...c.querySelectorAll("button")].find((b) => b.textContent === "All")!)
    expect(window.location.search).toBe("")
    expect(window.localStorage.getItem(PANINI_SCOPE_STORAGE_KEY)).toBeNull()
  })
  it("arrives scoped from the URL, else from what was remembered", async () => {
    window.history.replaceState(null, "", "/panini-blockchain/packs?property=bad-eggs")
    window.localStorage.setItem(PANINI_SCOPE_STORAGE_KEY, "nba")
    const a = render(<Harness />).container
    await waitFor(() => expect(a.querySelector('[data-testid="name"]')!.textContent).toBe("Bad Eggs"))
    cleanup()
    window.history.replaceState(null, "", "/panini-blockchain/packs")
    const b = render(<Harness />).container
    await waitFor(() => expect(b.querySelector('[data-testid="name"]')!.textContent).toBe("NBA"))
  })
  it("a remembered slug the index does not know is dropped, not applied", async () => {
    window.localStorage.setItem(PANINI_SCOPE_STORAGE_KEY, "retired-league")
    const c = render(<Harness />).container
    await waitFor(() => expect(c.querySelector('[data-testid="panini-scope-bar"]')).not.toBeNull())
    expect(c.querySelector('[data-testid="slug"]')!.textContent).toBe("")
  })
  it("a failed index read renders no control; a scoped arrival is told the filter is not applied", async () => {
    fetchState.ok = false
    const plain = render(<Harness />).container
    await new Promise((r) => setTimeout(r, 0))
    expect(plain.querySelector("button")).toBeNull()
    expect(plain.querySelector('[data-testid="panini-scope-unavailable"]')).toBeNull()
    cleanup()
    window.history.replaceState(null, "", "/panini-blockchain/packs?property=nba")
    const scoped = render(<Harness />).container
    await waitFor(() => expect(scoped.querySelector('[data-testid="panini-scope-unavailable"]')).not.toBeNull())
    expect(scoped.textContent).toMatch(/not filtered/)
  })
})

describe("collection cards honour the scope", () => {
  const card = (sku: string): PaniniOwnerCard => ({ sku, playerName: "P", setName: "S", sport: null, isListed: false, askUsd: null, fmvUsd: 1, flags: [], catalogued: true } as unknown as PaniniOwnerCard)
  it("keeps only cards whose set id is in scope; a card with no set id is out, never in", () => {
    const cards = [card("packcard-2332_1_1__1_10"), card("packcard-2120_1_1__1_10"), card("odd-sku")]
    const all = filterSortPaniniCards(cards, EMPTY_PANINI_CARD_FILTER, "fmv_desc")
    expect(all).toHaveLength(3)
    const nba = filterSortPaniniCards(cards, { ...EMPTY_PANINI_CARD_FILTER, setIds: new Set([2120]) }, "fmv_desc")
    expect(nba.map((c) => c.sku)).toEqual(["packcard-2120_1_1__1_10"])
  })
})

describe("GET /api/panini-properties", () => {
  it("answers leagues / brands that have a product id, and the id map", async () => {
    db.props = { data: [{ slug: "nba", name: "NBA", heading: "leagues", sort_order: 20 }, { slug: "wwe", name: "WWE", heading: "leagues", sort_order: 120 }], error: null }
    db.products = { data: [{ set_id: 2120, property_slug: "nba" }, { set_id: "bad", property_slug: "nba" }], error: null }
    const res = await GET()
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.properties.map((p: { slug: string }) => p.slug)).toEqual(["nba"])
    expect(j.setProperty).toEqual({ "2120": "nba" })
  })
  it("a failed read is an error, never an empty index", async () => {
    db.props = { data: null, error: { message: "boom" } }
    const res = await GET()
    expect(res.status).toBeGreaterThanOrEqual(500)
    const j = await res.json()
    expect(j.properties).toBeUndefined()
    db.props = { data: [], error: null }
    db.products = { data: null, error: { message: "boom", code: "57014" } }
    expect((await GET()).status).toBe(503)
  })
})
