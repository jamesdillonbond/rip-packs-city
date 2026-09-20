import { describe, it, expect } from "vitest"
import { setEntityHref, pinnacleRenderHref, editionHref } from "@/lib/entity-href"
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

  it("returns null for Pinnacle, whose sets have NO detail page", () => {
    // get_set_detail reads `sets` + `editions`; Pinnacle has 0 rows in both
    // (measured 2026-09-20), so /disney-pinnacle/set/<slug> 404s. Rendering the
    // link anyway is how the 54 dead Market links shipped.
    expect(setEntityHref("disney-pinnacle", "Pixar Animation Studios • Toy Story Vol.1")).toBeNull()
    expect(setEntityHref("pinnacle", "Pixar Animation Studios • Toy Story Vol.1")).toBeNull()
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
  // 🔄 INVERTED 2026-09-20, and the inversion IS the point — this block used to
  // assert that the canonical Pinnacle URL was NOT the `/edition/` spelling,
  // because the page lived at `/pinnacle/moment/<render_id>` and the house-shaped
  // URL 308'd away to it. The page moved into the collection namespace, so the
  // house-shaped URL is now the canonical one and the old URL is the redirect.
  // The property being pinned is unchanged: ONE canonical spelling, and internal
  // links use it rather than a redirect.
  it("points at the collection-namespaced edition page", () => {
    expect(pinnacleRenderHref("OEV1-TOYS-BUZZ-S4B")).toBe(
      "/disney-pinnacle/edition/OEV1-TOYS-BUZZ-S4B",
    )
  })

  it("is the SAME spelling as editionHref — one implementation, not two", () => {
    // ⛔ Two href builders for one collection is how Pinnacle accumulated its
    // special cases. pinnacleRenderHref is an alias and must stay one.
    for (const id of ["OEV1-TOYS-BUZZ-S4B", "STAR-OEV1-SWHM:Digital Display:1", "a/b c"]) {
      expect(pinnacleRenderHref(id)).toBe(editionHref("disney-pinnacle", null, id))
    }
  })

  it("never emits the retired /pinnacle/moment/ spelling", () => {
    // That URL still resolves — as a permanent redirect. An internal link to it
    // costs the reader a hop and hands the crawler a duplicate.
    expect(pinnacleRenderHref("OEV1-TOYS-BUZZ-S4B")).not.toMatch(/^\/pinnacle\/moment\//)
  })

  it("encodes an id that would otherwise break the path", () => {
    expect(pinnacleRenderHref("a/b c")).toBe("/disney-pinnacle/edition/a%2Fb%20c")
  })

  it("round-trips a legacy set-level key, which carries colons and spaces", () => {
    // These reach the disambiguation arm of the edition body; a mangled key
    // would 404 a page that exists.
    const key = "STAR-OEV1-SWHM:Digital Display:1"
    const href = pinnacleRenderHref(key)
    expect(decodeURIComponent(href.replace("/disney-pinnacle/edition/", ""))).toBe(key)
  })
})
