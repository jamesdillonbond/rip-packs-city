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
  it("points at the canonical render page", () => {
    expect(pinnacleRenderHref("OEV1-TOYS-BUZZ-S4B")).toBe("/pinnacle/moment/OEV1-TOYS-BUZZ-S4B")
  })

  it("is NOT the /disney-pinnacle/edition/ spelling, which 308s to it", () => {
    const id = "OEV1-TOYS-BUZZ-S4B"
    // editionHref still builds the redirecting form by design (it is the
    // edition-row helper); the set tracker must not use it for Pinnacle.
    expect(editionHref("disney-pinnacle", null, id)).toMatch(/\/edition\//)
    expect(pinnacleRenderHref(id)).not.toMatch(/\/edition\//)
    expect(pinnacleRenderHref(id)).not.toBe(editionHref("disney-pinnacle", null, id))
  })

  it("encodes an id that would otherwise break the path", () => {
    expect(pinnacleRenderHref("a/b c")).toBe("/pinnacle/moment/a%2Fb%20c")
  })
})
