// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import type React from "react"

/**
 * /leagues — the coverage map (2026-11-26).
 * - one tile per league however many publishers cover it (NBA = Top Shot + Panini; WWE = Panini + Candy);
 * - a publisher whose list failed to load is NAMED, never rendered as "covers nothing";
 * - the word "property" never renders; the page is anon-public and in the sitemap.
 */

vi.mock("next/link", () => ({ default: ({ children, href, ...rest }: { children: React.ReactNode; href: string; "data-testid"?: string }) => <a href={href} data-testid={rest["data-testid"]}>{children}</a> }))

import { buildLeagueMap, type CandyTile, type PaniniTile } from "@/lib/league-map"
import LeagueMap from "@/components/LeagueMap"
import { isPublicPath } from "@/proxy"

afterEach(cleanup)

const panini: PaniniTile[] = [
  { slug: "nba", name: "NBA", heading: "leagues", category: "Basketball", team_league: "nba", sort_order: 20, products: 12, editions: 9010 },
  { slug: "fifa-world-cup", name: "FIFA World Cup", heading: "leagues", category: "Soccer", team_league: null, sort_order: 10, products: 1, editions: 5000 },
  { slug: "wwe", name: "WWE", heading: "leagues", category: "Wrestling", team_league: null, sort_order: 120, products: 2, editions: 300 },
  { slug: "bad-eggs", name: "Bad Eggs", heading: "entertainment", category: "Entertainment", team_league: null, sort_order: 210, products: 1, editions: 7 },
  { slug: "racing", name: "Racing", heading: "leagues", category: "Racing", team_league: null, sort_order: 110, products: 0, editions: 0 },
]
const candy: CandyTile[] = [
  { slug: "mlb", name: "MLB", heading: "leagues", category: "Baseball", team_league: "mlb", sort_order: 10, collections: 88, cards: 926176 },
  { slug: "wwe", name: "WWE", heading: "leagues", category: "Wrestling", team_league: null, sort_order: 40, collections: 4, cards: 1698 },
  { slug: "dc", name: "DC", heading: "entertainment", category: "Comics", team_league: null, sort_order: 110, collections: 281, cards: 449854 },
]

describe("buildLeagueMap", () => {
  it("joins publishers onto one tile per league and keeps the dedicated collection first", () => {
    const m = buildLeagueMap({ panini, candy })
    const nba = m.leagues.find((e) => e.key === "nba")!
    expect(nba.sources.map((s) => s.label)).toEqual(["NBA Top Shot", "Panini"])
    expect(nba.sources[1]).toEqual({ label: "Panini", href: "/panini-blockchain/property/nba", detail: "12 products · 9,010 cards" })
    expect(m.leagues.find((e) => e.key === "wwe")!.sources.map((s) => s.label)).toEqual(["Panini", "Candy"])
    expect(m.leagues.find((e) => e.key === "mlb")!.sources[0].href).toBe("/candy-mlb/property/mlb")
    expect(m.leagues.find((e) => e.key === "mlb")!.teamHubs).toBe(true)
    expect(m.failed).toEqual([])
  })
  it("orders the big leagues first and leaves out a publisher row with nothing in it", () => {
    const m = buildLeagueMap({ panini, candy })
    expect(m.leagues.map((e) => e.key)).toEqual(["nba", "wnba", "nfl", "mlb", "fifa-world-cup", "laliga", "ufc", "wwe"])
    expect(m.entertainment.map((e) => e.key)).toEqual(["disney", "dc", "bad-eggs"])
  })
  it("a failed publisher read is named; the dedicated collections still render", () => {
    const m = buildLeagueMap({ panini: null, candy })
    expect(m.failed).toEqual(["Panini"])
    expect(m.leagues.find((e) => e.key === "nba")!.sources.map((s) => s.label)).toEqual(["NBA Top Shot"])
    expect(buildLeagueMap({ panini: null, candy: null }).failed).toEqual(["Panini", "Candy"])
  })
})

describe("LeagueMap", () => {
  it("renders two headings, team-hub links where hubs exist, and never the word 'property'", () => {
    const m = buildLeagueMap({ panini, candy })
    const { getByTestId, container, queryByTestId } = render(<LeagueMap {...m} />)
    expect(getByTestId("league-map-leagues").querySelector("h2")?.textContent).toBe("Leagues")
    expect(getByTestId("league-map-entertainment").querySelector("h2")?.textContent).toBe("Entertainment")
    expect(getByTestId("league-nba").textContent).toContain("NBA team hubs")
    expect(getByTestId("league-ufc").textContent).not.toContain("team hubs")
    expect(queryByTestId("league-map-partial")).toBeNull()
    expect(container.textContent?.toLowerCase()).not.toContain("property")
  })
  it("says which publisher's list is missing", () => {
    const m = buildLeagueMap({ panini: null, candy })
    const { getByTestId } = render(<LeagueMap {...m} />)
    expect(getByTestId("league-map-partial").textContent).toContain("Couldn’t load Panini’s list")
    expect(getByTestId("league-map-partial").textContent).toContain("not a gap in what it covers")
  })
})

describe("/leagues is public", () => {
  it("anon-public, exact match only", () => {
    expect(isPublicPath("/leagues", "GET")).toBe(true)
    expect(isPublicPath("/leagues/x", "GET")).toBe(false)
    expect(isPublicPath("/candy-mlb/property/dc", "GET")).toBe(true)
  })
})
