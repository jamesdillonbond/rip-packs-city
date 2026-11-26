// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import type React from "react"

/**
 * Candy leagues / brands (2026-11-26, migrations 20261126201206 + 20261126201654).
 * - the word "property" never renders (Trevor 11-26: headings are "Leagues" and "Entertainment");
 * - a failed read is not an empty board / an unknown brand;
 * - a collection RPC has catalogued no card of gets no set link; no sale on record never reads "$0".
 */

vi.mock("next/link", () => ({ default: ({ children, href, ...rest }: { children: React.ReactNode; href: string; "data-testid"?: string }) => <a href={href} data-testid={rest["data-testid"]}>{children}</a> }))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

import { toCandyPropertyBoard, readCandyPropertyBoard, toCandyPropertyPage, readCandyPropertyPage, candyPropertyHref, candySeasonSpan, groupCandyCollections } from "@/lib/candy/properties"
import { CandyPropertyGridView } from "@/components/collection/CandyPropertyGrid"
import CandyPropertyBody from "@/components/entity/CandyPropertyBody"
import { getCollection } from "@/lib/collections"

afterEach(cleanup)

const board = {
  computed_at: "2026-11-26T20:16:00Z",
  unplaced_collections: 2,
  properties: [
    { slug: "mlb", name: "MLB", heading: "leagues", category: "Baseball", subject_word: "player", team_league: "mlb", sort_order: 10, collections: 88, cards: 926176, editions: 13625, priced_editions: 2097, listed_editions: 1250, sales_90d: 6425, sales_90d_volume_usd: 77403.91, first_season: "2021", last_season: "2026" },
    { slug: "dc", name: "DC", heading: "entertainment", category: "Comics", subject_word: "character", team_league: null, sort_order: 110, collections: 281, cards: 449854, editions: 6410, priced_editions: 976, listed_editions: 557, sales_90d: 2493, sales_90d_volume_usd: "129791.16", first_season: null, last_season: null },
    { slug: "netflix", name: "Netflix", heading: "entertainment", category: "TV", subject_word: "character", team_league: null, sort_order: 120, collections: 3, cards: 6161, editions: 44, priced_editions: 15, listed_editions: 14, sales_90d: 0, sales_90d_volume_usd: null, first_season: "2022", last_season: "2022" },
    { slug: "bogus", name: "Bogus", heading: "sports", collections: 1 },
  ],
  set_property: { "batman-1940-2011-1": "dc", "2026-mlb-base-series-icons": "mlb", bad: 7 },
}

const page = {
  property: { slug: "dc", name: "DC", heading: "entertainment", category: "Comics", subject_word: "character", group_word: null, team_league: null },
  computed_at: "2026-11-26T20:16:00Z",
  totals: { collections: 3, cards: 5000, editions: 12, priced_editions: 5, listed_editions: 2, sales_90d: 9, sales_90d_volume_usd: 1200.5, newest_sale_at: "2026-11-25T10:00:00Z", first_season: null, last_season: null },
  collections: [
    { name: "Batman (1940-2011) #1", program: "Comics", season: null, set_slug: "batman-1940-2011-1", cards: 4950, editions: 5, priced_editions: 5, listed_editions: 2, sales_90d: 9, sales_90d_volume_usd: 1200.5, newest_sale_at: "2026-11-25T10:00:00Z" },
    { name: "The Bat Cowl Collection", program: "Bat Cowls", season: null, set_slug: "the-bat-cowl-collection", cards: 50, editions: 7, priced_editions: 0, listed_editions: 0, sales_90d: 0, sales_90d_volume_usd: null, newest_sale_at: null },
    { name: "DC Merge Fuel", program: "More from DC", season: null, set_slug: null, cards: 0, editions: 0, priced_editions: 0, listed_editions: 0, sales_90d: 0, sales_90d_volume_usd: null, newest_sale_at: null },
  ],
  top_editions: [{ external_id: "batman-1-legendary", name: "Batman (1940-2011) #1", player_name: null, set_name: "Batman (1940-2011) #1", tier: "LEGENDARY", circulation_count: 50, fmv_usd: 900 }, { external_id: "x", fmv_usd: null }],
  top_sales_90d: [{ external_id: "batman-1-legendary", name: "Batman (1940-2011) #1", player_name: null, set_name: "Batman (1940-2011) #1", serial_number: 7, price_usd: 800, sold_at: "2026-11-25T10:00:00Z" }],
  top_subjects: [],
}

describe("Candy property board", () => {
  it("parses rows, drops an unknown heading, keeps a null volume null, drops a non-string map value", () => {
    const b = toCandyPropertyBoard(board)!
    expect(b.properties.map((p) => p.slug)).toEqual(["mlb", "dc", "netflix"])
    expect(b.properties[1].sales_90d_volume_usd).toBe(129791.16)
    expect(b.properties[2].sales_90d_volume_usd).toBeNull()
    expect(b.setProperty).toEqual({ "batman-1940-2011-1": "dc", "2026-mlb-base-series-icons": "mlb" })
    expect(b.unplacedCollections).toBe(2)
  })
  it("a wrong shape or an error is a failed read, not an empty board", async () => {
    expect(toCandyPropertyBoard(null)).toBeNull()
    expect(toCandyPropertyBoard({ properties: "x" })).toBeNull()
    expect(await readCandyPropertyBoard({ rpc: async () => ({ data: null, error: { message: "boom" } }) })).toEqual({ ok: false, board: null })
    expect(await readCandyPropertyBoard({ rpc: async () => { throw new Error("x") } })).toEqual({ ok: false, board: null })
    const ok = await readCandyPropertyBoard({ rpc: async () => ({ data: board, error: null }) })
    expect(ok.ok && ok.board.properties.length).toBe(3)
  })
  it("href, season span, and the registry names Candy's reader", () => {
    expect(candyPropertyHref("candy-mlb", "dc")).toBe("/candy-mlb/property/dc")
    expect(candySeasonSpan({ first_season: "2021", last_season: "2026" })).toBe("2021 to 2026")
    expect(candySeasonSpan({ first_season: null, last_season: null })).toBeNull()
    expect(getCollection("candy-mlb")?.propertyPages).toBe("candy")
    expect(getCollection("panini-blockchain")?.propertyPages).toBe("panini")
    expect(getCollection("nba-top-shot")?.propertyPages).toBeUndefined()
  })
  it("the grid groups under Leagues and Entertainment and never says 'property' or '$0'", () => {
    const b = toCandyPropertyBoard(board)!
    const { getByTestId, container } = render(<CandyPropertyGridView collection="candy-mlb" properties={b.properties} unplaced={b.unplacedCollections} />)
    expect(getByTestId("candy-property-group-leagues").textContent).toContain("Leagues")
    expect(getByTestId("candy-property-group-entertainment").textContent).toContain("Entertainment")
    expect(getByTestId("candy-property-dc").getAttribute("href")).toBe("/candy-mlb/property/dc")
    expect(getByTestId("candy-property-netflix").textContent).toContain("no sale on record in 90 days")
    expect(getByTestId("candy-property-unplaced").textContent).toContain("2 more collections")
    expect(container.textContent?.toLowerCase()).not.toContain("property")
    expect(container.textContent).not.toContain("$0")
  })
  it("no tiles renders nothing", () => {
    const { container } = render(<CandyPropertyGridView collection="candy-mlb" properties={[]} />)
    expect(container.innerHTML).toBe("")
  })
})

describe("Candy property page", () => {
  it("null is an unknown brand; a wrong shape is a failed read; no collections is a 404", async () => {
    expect(toCandyPropertyPage(null)).toBeNull()
    expect(toCandyPropertyPage({ property: {}, totals: {}, collections: [] })).toBeUndefined()
    expect(toCandyPropertyPage({ ...page, collections: [] })).toBeNull()
    expect(await readCandyPropertyPage("dc", { rpc: async () => ({ data: null, error: { message: "boom" } }) })).toEqual({ ok: false, page: null })
    expect(await readCandyPropertyPage("nope", { rpc: async () => ({ data: null, error: null }) })).toEqual({ ok: true, page: null })
    expect(await readCandyPropertyPage("dc", { rpc: async () => ({ data: { junk: 1 }, error: null }) })).toEqual({ ok: false, page: null })
  })
  it("groups collections by line, tail groups last, and drops an unpriced 'top' row", () => {
    const p = toCandyPropertyPage(page)!
    expect(p.top_editions.length).toBe(1)
    expect(groupCandyCollections(p.collections).map((g) => g.program)).toEqual(["Comics", "Bat Cowls", "More from DC"])
    expect(groupCandyCollections([{ ...p.collections[0], program: null }]).map((g) => g.program)).toEqual([null])
  })
  it("renders the brand, links only catalogued collections, and never says 'property'", () => {
    const p = toCandyPropertyPage(page)!
    const { getByTestId, container } = render(<CandyPropertyBody collection="candy-mlb" collectionLabel="Candy" page={p} />)
    expect(container.querySelector("h1")?.textContent).toBe("Candy DC cards")
    const links = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))
    expect(links).toContain("/candy-mlb/set/batman-1940-2011-1")
    expect(links.some((h) => h?.includes("dc-merge-fuel"))).toBe(false)
    expect(links).toContain("/candy-mlb/edition/batman-1-legendary")
    expect(getByTestId("candy-property-programs").textContent).toContain("Comics (1)")
    expect(container.querySelector('[data-testid="candy-property-subjects"]')).toBeNull()
    expect(container.textContent?.toLowerCase()).not.toContain("property")
    expect(container.textContent).not.toContain("$0")
  })
})
