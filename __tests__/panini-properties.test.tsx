// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import type React from "react"

/**
 * Panini leagues / entertainment grouping (2026-11-26, migration 20261126185023).
 * - the word "property" never renders (Trevor 11-26: headings are "Leagues" and "Entertainment");
 * - a failed board read is not an empty board; the index then groups by sport exactly as before;
 * - a product no rule places lands under "Other", never under a guessed league.
 */

vi.mock("next/link", () => ({ default: ({ children, href, ...rest }: { children: React.ReactNode; href: string; "data-testid"?: string }) => <a href={href} data-testid={rest["data-testid"]}>{children}</a> }))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

import { toPropertyBoard, readPaniniPropertyBoard, seasonSpan, paniniPropertyHref, paniniPropertyIndexHref, subjectPlural, toPropertyPage, readPaniniPropertyPage, type PaniniProperty } from "@/lib/panini/properties"
import { PaniniPropertyGridView } from "@/components/collection/PaniniPropertyGrid"
import PaniniProductIndex, { type PaniniProductIndexRow } from "@/components/entity/PaniniProductIndex"

afterEach(cleanup)

const raw = {
  computed_at: "2026-11-26T18:06:00Z",
  unplaced_products: 1,
  properties: [
    { slug: "nba", name: "NBA", heading: "leagues", category: "Basketball", team_league: "nba", sort_order: 20, products: 2, editions: 900, fmv_total_usd: "5000.5", listed_editions: 10, sales_30d: 40, sales_30d_volume_usd: 700, first_season: "2021", last_season: "2024-25" },
    { slug: "fifa-world-cup", name: "FIFA World Cup", heading: "leagues", category: "Soccer", team_league: null, sort_order: 10, products: 1, editions: 50, fmv_total_usd: null, listed_editions: 5, sales_30d: 900, sales_30d_volume_usd: 9000, first_season: "2026", last_season: "2026" },
    { slug: "bad-eggs", name: "Bad Eggs", heading: "entertainment", category: "Entertainment", team_league: null, sort_order: 210, products: 1, editions: 7, fmv_total_usd: 10, listed_editions: 1, sales_30d: 3, sales_30d_volume_usd: null, first_season: null, last_season: null },
    { slug: "bogus", name: "Bogus", heading: "sports", products: 1 },
  ],
  product_property: { b1: "nba", s1: "fifa-world-cup", e1: "bad-eggs", bad: 7 },
}

describe("toPropertyBoard / readPaniniPropertyBoard", () => {
  it("parses rows, drops a row with an unknown heading, keeps a null FMV null", () => {
    const b = toPropertyBoard(raw)!
    expect(b.properties.map((p) => p.slug)).toEqual(["nba", "fifa-world-cup", "bad-eggs"])
    expect(b.properties[0].fmv_total_usd).toBe(5000.5)
    expect(b.properties[1].fmv_total_usd).toBeNull()
    expect(b.productProperty).toEqual({ b1: "nba", s1: "fifa-world-cup", e1: "bad-eggs" })
    expect(b.unplacedProducts).toBe(1)
  })
  it("a wrong shape is a failed read, not an empty board", async () => {
    expect(toPropertyBoard(null)).toBeNull()
    expect(toPropertyBoard([])).toBeNull()
    expect(toPropertyBoard({ properties: "x" })).toBeNull()
    expect(await readPaniniPropertyBoard({ rpc: async () => ({ data: null, error: { message: "boom" } }) })).toEqual({ ok: false, board: null })
    expect(await readPaniniPropertyBoard({ rpc: async () => ({ data: [], error: null }) })).toEqual({ ok: false, board: null })
    expect(await readPaniniPropertyBoard({ rpc: async () => { throw new Error("x") } })).toEqual({ ok: false, board: null })
    const ok = await readPaniniPropertyBoard({ rpc: async () => ({ data: raw, error: null }) })
    expect(ok.ok && ok.board.properties.length).toBe(3)
  })
  it("season span and href", () => {
    expect(seasonSpan({ first_season: "2021", last_season: "2024-25" })).toBe("2021 to 2024-25")
    expect(seasonSpan({ first_season: "2026", last_season: "2026" })).toBe("2026")
    expect(seasonSpan({ first_season: null, last_season: null })).toBeNull()
    expect(paniniPropertyHref("panini-blockchain", "nba")).toBe("/panini-blockchain/property/nba")
    expect(paniniPropertyIndexHref("panini-blockchain", "nba")).toBe("/panini-blockchain/product#nba")
  })
})

describe("PaniniPropertyGridView", () => {
  const props = toPropertyBoard(raw)!.properties as PaniniProperty[]
  it("two headings, tiles ordered by 30-day dollars, each linking its index section", () => {
    const c = render(<PaniniPropertyGridView collection="panini-blockchain" properties={props} />).container
    expect([...c.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["Leagues", "Entertainment"])
    const leagues = c.querySelector('[data-testid="panini-property-group-leagues"]')!
    expect([...leagues.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["/panini-blockchain/property/fifa-world-cup", "/panini-blockchain/property/nba"])
    expect(c.textContent).toContain("2021 to 2024-25")
    expect(c.textContent).toContain("900 cards")
  })
  it("never renders the word property, an FMV tier, or a $0 for unknown dollars", () => {
    const c = render(<PaniniPropertyGridView collection="panini-blockchain" properties={props} />).container
    expect(c.textContent).not.toMatch(/propert/i)
    expect(c.textContent).not.toMatch(/\b(HIGH|MEDIUM|LOW|ASK_ONLY)\b/)
    expect(c.querySelector('[data-testid="panini-property-bad-eggs"]')!.textContent).not.toContain("$")
  })
  it("no rows renders nothing (never an empty grid)", () => {
    expect(render(<PaniniPropertyGridView collection="panini-blockchain" properties={[]} />).container.innerHTML).toBe("")
  })
})

const row = (over: Partial<PaniniProductIndexRow>): PaniniProductIndexRow => ({
  name: "P", slug: "p", sport: "Soccer", editions: 1, sets: 1, fmv_total_usd: 10, listed_editions: 1, sales_30d: 0, ...over,
})

describe("PaniniProductIndex with the board", () => {
  const rows = [
    row({ name: "Hoops", slug: "b1", sport: "Basketball", editions: 900 }),
    row({ name: "WC Prizm", slug: "s1", sport: "Soccer", editions: 50 }),
    row({ name: "Eggs", slug: "e1", sport: null, editions: 7 }),
    row({ name: "Mystery", slug: "m1", sport: "Soccer", editions: 9999 }),
  ]
  it("groups under Leagues then Entertainment, anchors each group, and puts an unplaced product under Other", () => {
    const c = render(<PaniniProductIndex collection="panini-blockchain" collectionLabel="Panini" rows={rows} board={toPropertyBoard(raw)} />).container
    expect([...c.querySelectorAll('[data-testid="panini-product-index-heading"]')].map((h) => h.textContent)).toEqual(["Leagues", "Entertainment"])
    expect([...c.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(["NBA →", "FIFA World Cup →", "Bad Eggs →", "Other"])
    expect(c.querySelector("section#nba tbody a")!.getAttribute("href")).toBe("/panini-blockchain/product/b1")
    expect(c.querySelector('[data-testid="panini-product-index-group-nba"]')!.getAttribute("href")).toBe("/panini-blockchain/property/nba")
    expect(c.querySelector("section#fifa-world-cup")).not.toBeNull()
    const other = [...c.querySelectorAll("section")].find((s) => s.querySelector("h2")?.textContent === "Other")!
    expect(other.textContent).toContain("Mystery")
    expect(c.textContent).not.toMatch(/propert/i)
  })
  it("without the board it groups by sport, as before", () => {
    const c = render(<PaniniProductIndex collection="panini-blockchain" collectionLabel="Panini" rows={rows} board={null} />).container
    expect([...c.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(["Soccer", "Basketball", "Other"])
    expect(c.querySelector('[data-testid="panini-product-index-heading"]')).toBeNull()
  })
})

import PaniniPropertyBody, { PaniniPropertyUnavailable } from "@/components/entity/PaniniPropertyBody"

const rawPage = {
  property: { slug: "bad-eggs", name: "Bad Eggs", heading: "entertainment", category: "Entertainment", subject_word: "character", group_word: "clan", team_league: null },
  computed_at: "2026-11-26T18:06:00Z",
  totals: { products: 2, editions: 430, priced_editions: 400, fmv_total_usd: 1234.5, listed_editions: 300, cheapest_ask_usd: 1, sales_30d: 0, sales_30d_volume_usd: null, newest_sale_at: null, first_season: "2025", last_season: "2026" },
  products: [
    { slug: "eggs-26", name: "2026 Bad Eggs", season: "2026", editions: 274, sets: 15, fmv_total_usd: 900, listed_editions: 200, sales_30d: 0, sales_30d_volume_usd: null },
    { slug: "eggs-25", name: "2025 Bad Eggs", season: "2025", editions: 156, sets: 9, fmv_total_usd: null, listed_editions: 100, sales_30d: 0, sales_30d_volume_usd: null },
    { name: "no slug" },
  ],
  top_editions: [{ external_id: "packcard-1_2_3", player_name: "Slice", parallel: "Gold", mint_cap: 10, fmv_usd: 5000, low_ask_usd: null }, { player_name: "no id" }],
  top_sales_90d: [],
  top_subjects: [
    { player_name: "Slice", editions: 12, priced_editions: 10, fmv_total_usd: 700 },
    { player_name: "Benny | Helz", editions: 2, priced_editions: 0, fmv_total_usd: null },
  ],
}

describe("the page per league / brand", () => {
  it("parses; null = none; a league with no product page is a 404 (null), a wrong shape is a failed read", async () => {
    const p = toPropertyPage(rawPage)!
    expect(p.products.map((x) => x.slug)).toEqual(["eggs-26", "eggs-25"])
    expect(p.products[1].fmv_total_usd).toBeNull()
    expect(p.top_editions).toHaveLength(1)
    expect(toPropertyPage(null)).toBeNull()
    expect(toPropertyPage({ ...rawPage, products: [] })).toBeNull()
    expect(toPropertyPage({ property: {} })).toBeUndefined()
    expect(toPropertyPage("x")).toBeUndefined()
    expect(await readPaniniPropertyPage("x", { rpc: async () => ({ data: null, error: { message: "boom" } }) })).toEqual({ ok: false, page: null })
    expect(await readPaniniPropertyPage("x", { rpc: async () => ({ data: { property: {} }, error: null }) })).toEqual({ ok: false, page: null })
    expect(await readPaniniPropertyPage("x", { rpc: async () => ({ data: null, error: null }) })).toEqual({ ok: true, page: null })
    expect(await readPaniniPropertyPage("x", { rpc: async () => { throw new Error("x") } })).toEqual({ ok: false, page: null })
    const ok = await readPaniniPropertyPage("bad-eggs", { rpc: async () => ({ data: rawPage, error: null }) })
    expect(ok.ok && ok.page?.name).toBe("Bad Eggs")
  })
  it("subject words", () => {
    expect(subjectPlural("character")).toBe("Characters")
    expect(subjectPlural("artist")).toBe("Artists")
    expect(subjectPlural(null)).toBe("Players")
  })
  it("renders the brand's own words, links products and single subjects, and makes no false sales claim", () => {
    const c = render(<PaniniPropertyBody collection="panini-blockchain" collectionLabel="Panini" page={toPropertyPage(rawPage)!} />).container
    expect(c.querySelector("h1")!.textContent).toBe("Panini Bad Eggs cards")
    expect([...c.querySelectorAll("h2")].map((h) => h.textContent)).toContain("Top Characters")
    expect(c.textContent).not.toMatch(/Top Players/)
    expect(c.textContent).not.toMatch(/propert/i)
    expect(c.textContent).not.toMatch(/\b(HIGH|MEDIUM|LOW|ASK_ONLY)\b/)
    expect(c.querySelector('[data-testid="panini-property-products"] a')!.getAttribute("href")).toBe("/panini-blockchain/product/eggs-26")
    const subjects = c.querySelector('[data-testid="panini-property-subjects"]')!
    expect([...subjects.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["/panini-blockchain/player/slice"])
    expect(subjects.textContent).toContain("no FMV yet")
    expect(c.querySelector('[data-testid="panini-property-no-sales"]')).not.toBeNull()
    expect(c.textContent).toContain("none on record yet")
    expect(c.querySelector('[data-testid="panini-property-teams"]')).toBeNull()
  })
  it("a league links its team hubs; the unavailable state never says the cards are gone", () => {
    const league = toPropertyPage({ ...rawPage, property: { ...rawPage.property, slug: "nba", name: "NBA", heading: "leagues", category: "Basketball", subject_word: "player", team_league: "nba" } })!
    const c = render(<PaniniPropertyBody collection="panini-blockchain" collectionLabel="Panini" page={league} />).container
    expect(c.querySelector('[data-testid="panini-property-teams"]')!.getAttribute("href")).toBe("/teams")
    expect([...c.querySelectorAll("h2")].map((h) => h.textContent)).toContain("Top Players")
    const u = render(<PaniniPropertyUnavailable collection="panini-blockchain" />).container
    expect(u.textContent).toMatch(/does not mean the cards are gone/)
  })
})
