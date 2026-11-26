// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import type React from "react"

/**
 * 2026-11-26 (migration 20261126214413):
 * - a Panini league's teams / nations / clans section says how many cards name one, and never "property";
 * - the Prizm / Select brand-line filter reads the product's own name — no line is "—", never a guess;
 * - the dashboard's league split renders nothing on a failed read or a one-league holding;
 * - /api/league-split passes a Solana key through untouched and refuses a bad owner.
 */

vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
const db = vi.hoisted(() => ({ calls: [] as Array<[string, Record<string, unknown>]>, res: { data: null as unknown, error: null as unknown } }))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async (fn: string, args: Record<string, unknown>) => { db.calls.push([fn, args]); return db.res } } }))
const fj = vi.hoisted(() => ({ ok: true, json: null as unknown }))
vi.mock("@/lib/analytics/fetch-json", () => ({ fetchJson: async () => ({ ok: fj.ok, json: fj.ok ? fj.json : null }) }))

import { paniniBrandLine, brandLineOptions } from "@/lib/panini/brand-line"
import { toPropertyGroups, readPaniniPropertyGroups, toPropertyPage } from "@/lib/panini/properties"
import { groupPlural } from "@/lib/property-words"
import PaniniPropertyBody from "@/components/entity/PaniniPropertyBody"
import { toLeagueSplit, leagueSplitLine } from "@/lib/league-split"
import LeagueSplitLine, { LeagueSplitStrip } from "@/components/dashboard/LeagueSplitLine"
import { GET } from "@/app/api/league-split/route"
import { isPublicPath } from "@/proxy"

afterEach(cleanup)
beforeEach(() => { db.calls.length = 0; db.res = { data: null, error: null }; fj.ok = true; fj.json = null })

const product = (slug: string, name: string) => ({ slug, name, season: "2024", editions: 100, sets: 5, fmv_total_usd: 1000, listed_editions: 3, sales_30d: 2, sales_30d_volume_usd: 50 })
const page = toPropertyPage({
  property: { slug: "nba", name: "NBA", heading: "leagues", category: "Basketball", subject_word: "player", group_word: "team", team_league: "nba" },
  computed_at: "2026-11-26T20:00:00Z",
  totals: { products: 3, editions: 300, priced_editions: 200, fmv_total_usd: 3000, listed_editions: 9, cheapest_ask_usd: 1, sales_30d: 6, sales_30d_volume_usd: 150, newest_sale_at: null, first_season: "2021", last_season: "2024-25" },
  products: [product("a", "2024-25 Panini NFT Prizm Basketball"), product("b", "2021-22 Panini NFT Donruss Optic Basketball"), product("c", "Panini product 2015")],
  top_editions: [], top_sales_90d: [], top_subjects: [],
})!
const groupsRaw = { group_word: "team", editions_total: 14341, editions_named: 13703, groups_total: 46, groups: [{ name: "San Antonio Spurs", editions: 584, priced_editions: 581, fmv_total_usd: 120282.51 }, { name: "Los Angeles Lakers", editions: 703, priced_editions: 700, fmv_total_usd: null }, { name: "" }] }

describe("brand line", () => {
  it("reads the line from the product's own name; none is null", () => {
    expect(paniniBrandLine("2024-25 Panini NFT Prizm Basketball")).toBe("Prizm")
    expect(paniniBrandLine("2021-22 Panini NFT Donruss Optic Basketball")).toBe("Donruss Optic")
    expect(paniniBrandLine("2022-23 Panini NFT Best of The NBA")).toBe("Best of")
    expect(paniniBrandLine("Panini product 2015")).toBeNull()
    expect(paniniBrandLine(null)).toBeNull()
    expect(brandLineOptions(["2024 Panini NFT Prizm WNBA", "2025 Panini NFT Prizm WNBA", "2025 Panini NFT Select Racing", "Panini product 1"])).toEqual([{ line: "Prizm", products: 2 }, { line: "Select", products: 1 }])
  })
})

describe("teams / nations / clans of a league", () => {
  it("parses, drops a nameless row, and a wrong shape or a failed read is null", async () => {
    const g = toPropertyGroups(groupsRaw)!
    expect(g.groups.map((x) => x.name)).toEqual(["San Antonio Spurs", "Los Angeles Lakers"])
    expect(g.groups[1].fmv_total_usd).toBeNull()
    expect(toPropertyGroups(null)).toBeNull()
    expect(toPropertyGroups({ groups: "x" })).toBeNull()
    expect(await readPaniniPropertyGroups("nba", { rpc: async () => ({ data: null, error: { message: "boom" } }) })).toBeNull()
    expect(await readPaniniPropertyGroups("nba", { rpc: async () => { throw new Error("x") } })).toBeNull()
    expect((await readPaniniPropertyGroups("nba", { rpc: async () => ({ data: groupsRaw, error: null }) }))!.groups_total).toBe(46)
    expect(groupPlural("nation")).toBe("Nations")
    expect(groupPlural(null)).toBeNull()
  })
  it("the section states its denominator; without groups (failed read) the page renders with no such section", () => {
    const withGroups = render(<PaniniPropertyBody collection="panini-blockchain" collectionLabel="Panini Blockchain" page={page} groups={toPropertyGroups(groupsRaw)} />)
    const note = withGroups.getByTestId("panini-property-groups-note").textContent!
    expect(note).toContain("13,703 of 14,341 NBA cards name a team")
    expect(note).toContain("Top 2 of 46")
    expect(withGroups.getByTestId("panini-property-groups").textContent).toContain("no FMV yet")
    expect(withGroups.container.textContent?.toLowerCase()).not.toContain("property")
    cleanup()
    const without = render(<PaniniPropertyBody collection="panini-blockchain" collectionLabel="Panini Blockchain" page={page} />)
    expect(without.queryByTestId("panini-property-groups")).toBeNull()
  })
  it("the brand-line chips filter the products; a product with no line shows a dash and only under All", () => {
    const c = render(<PaniniPropertyBody collection="panini-blockchain" collectionLabel="Panini Blockchain" page={page} />)
    const chips = [...c.getByTestId("panini-property-lines").querySelectorAll("button")]
    expect(chips.map((b) => b.textContent)).toEqual(["All · 3", "Donruss Optic · 1", "Prizm · 1"])
    const rows = () => [...c.getByTestId("panini-property-products").querySelectorAll("tbody tr")].map((r) => r.textContent)
    expect(rows()).toHaveLength(3)
    expect(rows()[2]).toContain("—")
    fireEvent.click(chips[2])
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toContain("Prizm Basketball")
    expect(chips[2].getAttribute("aria-pressed")).toBe("true")
  })
})

describe("league split", () => {
  const raw = { cards_total: 8124, unplaced: 203, leagues: [{ slug: "nba", name: "NBA", heading: "leagues", cards: 1556 }, { slug: "nfl", name: "NFL", heading: "leagues", cards: 3647 }, { slug: "wnba", name: "WNBA", cards: 769 }, { slug: "x", name: "X", cards: 0 }, { slug: "wwe", name: "WWE", cards: 271 }] }
  it("orders by cards, drops empty rows, and summarises; one league or none is no line", () => {
    const s = toLeagueSplit(raw)!
    expect(s.leagues.map((l) => l.slug)).toEqual(["nfl", "nba", "wnba", "wwe"])
    expect(s.unplaced).toBe(203)
    expect(leagueSplitLine(s)).toBe("NFL 3,647 · NBA 1,556 · WNBA 769 · +1 more")
    expect(leagueSplitLine(toLeagueSplit({ cards_total: 5, leagues: [{ slug: "mlb", name: "MLB", cards: 5 }] })!)).toBeNull()
    expect(toLeagueSplit({ leagues: [] })).toBeNull()
    expect(toLeagueSplit(null)).toBeNull()
  })
  it("the tile line renders the split, and nothing on a failed read", async () => {
    fj.json = raw
    const ok = render(<LeagueSplitLine publisher="panini" owner="spinotron" />)
    await waitFor(() => expect(ok.queryByTestId("league-split-panini")).not.toBeNull())
    expect(ok.getByTestId("league-split-panini").textContent).toBe("NFL 3,647 · NBA 1,556 · WNBA 769 · +1 more")
    cleanup()
    fj.ok = false
    const failed = render(<LeagueSplitLine publisher="candy" owner="W" />)
    await new Promise((r) => setTimeout(r, 10))
    expect(failed.container.innerHTML).toBe("")
  })
  it("the Binder strip links every brand's page and counts what is not placed; one brand or a failed read is nothing", async () => {
    fj.json = raw
    const ok = render(<LeagueSplitStrip publisher="candy" owner="W" collection="candy-mlb" />)
    await waitFor(() => expect(ok.queryByTestId("league-split-strip")).not.toBeNull())
    const strip = ok.getByTestId("league-split-strip")
    expect([...strip.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["/candy-mlb/property/nfl", "/candy-mlb/property/nba", "/candy-mlb/property/wnba", "/candy-mlb/property/wwe"])
    expect(strip.textContent).toContain("203 not placed")
    expect(strip.textContent?.toLowerCase()).not.toContain("property")
    cleanup()
    fj.json = { cards_total: 5, unplaced: 0, leagues: [{ slug: "mlb", name: "MLB", cards: 5 }] }
    const one = render(<LeagueSplitStrip publisher="candy" owner="W" collection="candy-mlb" />)
    await new Promise((r) => setTimeout(r, 10))
    expect(one.container.innerHTML).toBe("")
    cleanup()
    fj.ok = false
    const failed = render(<LeagueSplitStrip publisher="candy" owner="W" collection="candy-mlb" />)
    await new Promise((r) => setTimeout(r, 10))
    expect(failed.container.innerHTML).toBe("")
  })
  const req = (q: string) => ({ nextUrl: new URL(`https://t/api/league-split?${q}`) }) as never
  it("the API passes a Solana key through untouched, lower-cases nothing, and names the right function", async () => {
    db.res = { data: raw, error: null }
    const wallet = "6uKecEEDfWyWY6HLkPJ2kpKUgq8HekLRjtuTatoPqCaW"
    const res = await GET(req(`publisher=candy&owner=${wallet}`))
    expect(res.status).toBe(200)
    expect(db.calls).toEqual([["candy_wallet_property_split", { p_wallet: wallet }]])
    expect((await res.json()).leagues[0].slug).toBe("nfl")
    await GET(req("publisher=panini&owner=spinotron"))
    expect(db.calls[1]).toEqual(["panini_owner_property_split", { p_username: "spinotron" }])
  })
  it("a bad publisher or owner is a 400 before any read; a failed or malformed read is a server error, never an empty split", async () => {
    expect((await GET(req("publisher=topps&owner=x"))).status).toBe(400)
    expect((await GET(req("publisher=candy&owner=0x1d4b4c1f2e3a4b5c"))).status).toBe(400)
    expect((await GET(req("publisher=panini&owner="))).status).toBe(400)
    expect(db.calls).toHaveLength(0)
    db.res = { data: null, error: { message: "boom", code: "57014" } }
    const failed = await GET(req("publisher=panini&owner=spinotron"))
    expect(failed.status).toBeGreaterThanOrEqual(500)
    expect(await failed.json()).not.toHaveProperty("leagues")
    db.res = { data: [], error: null }
    expect((await GET(req("publisher=panini&owner=spinotron"))).status).toBeGreaterThanOrEqual(500)
  })
  it("is anon-public for GET only", () => {
    expect(isPublicPath("/api/league-split", "GET")).toBe(true)
    expect(isPublicPath("/api/league-split", "POST")).toBe(false)
  })
})
