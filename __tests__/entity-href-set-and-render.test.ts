import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { setEntityHref, pinnacleRenderHref, editionHref, editionRouteHref, pinnacleCharacterHref, pinnacleFranchiseHref, pinnacleSeriesHref } from "@/lib/entity-href"
import { publishedCollections } from "@/lib/collections"

/**
 * The two href rules the Disney Pinnacle Set Tracker depends on.
 *
 * Both are stated as the ABSENCE of a dead or redirecting link, because that is
 * the failure mode: a link that is FORMED correctly and RESOLVES to nothing
 * looks identical to a working one in every test that only checks the string.
 */
describe("setEntityHref", () => {
  it("routes a set to its detail page for collections that have one", () => {
    expect(setEntityHref("nba-top-shot", "Base Set")).toBe("/nba-top-shot/set/base-set")
    expect(setEntityHref("nfl-all-day", "Base Set")).toBe("/nfl-all-day/set/base-set")
    expect(setEntityHref("laliga-golazos", "Base Set")).toBe("/laliga-golazos/set/base-set")
  })

  it("routes a Pinnacle set to its page (resolves since 2026-09-26)", () => {
    // RE-PINNED 2026-09-27 — the premise changed, the property did not. This
    // used to assert null because get_set_detail had no Pinnacle rows (measured
    // 2026-09-20). The 09-26 migration gave sets_summary a pinnacle_catalog arm;
    // 177 of 178 catalog set names now resolve with this exact slug (the miss
    // was a set first seen after that day's refresh).
    expect(setEntityHref("disney-pinnacle", "Pixar Animation Studios • Toy Story Vol.1"))
      .toBe("/disney-pinnacle/set/pixar-animation-studios-toy-story-vol-1")
  })

  it("returns null for an absent or blank set name rather than a /set/ URL to nowhere", () => {
    expect(setEntityHref("nba-top-shot", null)).toBeNull()
    expect(setEntityHref("nba-top-shot", "   ")).toBeNull()
  })

  it("is not vacuous — at least one published collection still gets a real href", () => {
    const withHref = publishedCollections().filter((c) => setEntityHref(c.id, "Base Set") !== null)
    expect(withHref.length).toBeGreaterThan(0)
  })
})

describe("pinnacleRenderHref", () => {
  it("points at the canonical render page", () => {
    expect(pinnacleRenderHref("OEV1-TOYS-BUZZ-S4B")).toBe("/pinnacle/moment/OEV1-TOYS-BUZZ-S4B")
  })

  it("is NOT the /disney-pinnacle/edition/ spelling, which only redirects to it", () => {
    const id = "OEV1-TOYS-BUZZ-S4B"
    expect(pinnacleRenderHref(id)).not.toMatch(/\/edition\//)
    // INVERTED 2026-09-27: editionHref used to build the redirecting form for
    // Pinnacle. That page permanentRedirects EVERY Pinnacle slug here, and does
    // it after the stream starts — a 200 placeholder plus a client hop (live
    // sweep). The helpers now link the target directly.
    expect(editionHref("disney-pinnacle", null, id)).toBe(pinnacleRenderHref(id))
    expect(editionRouteHref("disney-pinnacle", id)).toBe(pinnacleRenderHref(id))
  })

  it("CONTROL: every other collection keeps its /<slug>/edition/<key> route", () => {
    expect(editionRouteHref("nba-top-shot", "98:3150")).toBe("/nba-top-shot/edition/98%3A3150")
    expect(editionHref("nba-top-shot", "98:3150", "uuid")).toBe("/nba-top-shot/edition/98%3A3150")
  })

  it("encodes an id that would otherwise break the path", () => {
    expect(pinnacleRenderHref("a/b c")).toBe("/pinnacle/moment/a%2Fb%20c")
  })
})

// 2026-09-27: the pin page's entity links. Each asserts the slug the page's
// resolver actually accepts (measured live that day), not merely a formed URL.
describe("Pinnacle entity links from a pin page", () => {
  it("franchise drops ™ — get_team_detail resolves star-wars, not star-wars- (404)", () => {
    expect(pinnacleFranchiseHref("Star Wars™")).toBe("/disney-pinnacle/team/star-wars")
    expect(pinnacleFranchiseHref("Mickey & Friends")).toBe("/disney-pinnacle/team/mickey-friends")
  })
  it("character from the Characters trait value", () => {
    expect(pinnacleCharacterHref("Wicket W. Warrick")).toBe("/disney-pinnacle/player/wicket-w-warrick")
  })
  it("series by its name", () => {
    expect(pinnacleSeriesHref("2026")).toBe("/disney-pinnacle/series/2026")
  })
})

// 2026-10-21 (#204): a Panini set NAME spans products; the name slug of one the 2026 World Cup
// catalog carries IS that catalog's set. A row's edition key names its product, so the link goes
// to the edition's OWN product's set page — never another product's.
describe("setEntityHref — Panini rows link their own product's set", () => {
  it("a 2022-23 Basketball card's 'Base Prizms Blue' links that product's set, not the World Cup set", () => {
    expect(setEntityHref("panini-blockchain", "Base Prizms Blue", "packcard-1819_346882_9127452_138")).toBe("/panini-blockchain/set/p1819-base-prizms-blue")
  })
  it("a 2026 World Cup (2332) card links the plain slug — the catalog's own key", () => {
    expect(setEntityHref("panini-blockchain", "Base Prizms Blue", "packcard-2332_486967_12675075_10")).toBe("/panini-blockchain/set/base-prizms-blue")
  })
  it("CONTROLS: no key, an unparseable key, or another collection keep the name slug", () => {
    expect(setEntityHref("panini-blockchain", "Base Prizms Blue")).toBe("/panini-blockchain/set/base-prizms-blue")
    expect(setEntityHref("panini-blockchain", "Base Prizms Blue", "weird-key")).toBe("/panini-blockchain/set/base-prizms-blue")
    expect(setEntityHref("nba-top-shot", "Base Set", "packcard-1819_1")).toBe("/nba-top-shot/set/base-set")
  })
  it("both Panini row tables pass the edition key", () => {
    const table = readFileSync("components/collection/CollectionMomentTable.tsx", "utf8")
    expect(table.match(/setEntityHref\(collectionSlug, row\.setName, row\.editionKey\)/g)?.length).toBe(4)
    expect(table).not.toMatch(/setEntityHref\(collectionSlug, row\.setName\)/)
    const market = readFileSync("app/(collections)/[collection]/market/MarketClient.tsx", "utf8")
    expect(market).toContain("setEntityHref(collectionUrlSlug, l.setName, l.editionKey)")
  })
})
