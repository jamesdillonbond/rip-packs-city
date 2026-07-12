import { describe, it, expect } from "vitest"
import { entityUrl, collectionDisplayName } from "@/lib/seo"

// SEO URL + display-name builders feed canonical <link>s, JSON-LD, and OG tags
// that crawlers index. A regression here poisons the search index or points
// canonicals at the wrong host, so pin the exact output shape.

describe("entityUrl", () => {
  it("builds an absolute URL under the site origin", () => {
    expect(entityUrl("nba-top-shot", "player", "damian-lillard")).toBe(
      "https://www.rippackscity.com/nba-top-shot/player/damian-lillard"
    )
  })

  it("URL-encodes the slug segment (spaces, ampersands)", () => {
    expect(entityUrl("nfl-all-day", "team", "san francisco 49ers")).toBe(
      "https://www.rippackscity.com/nfl-all-day/team/san%20francisco%2049ers"
    )
    expect(entityUrl("nba-top-shot", "set", "run & gun")).toContain(
      "/set/run%20%26%20gun"
    )
  })
})

describe("collectionDisplayName", () => {
  it("maps known collection url-slugs to their display names", () => {
    expect(collectionDisplayName("nba-top-shot")).toBe("NBA Top Shot")
    expect(collectionDisplayName("nfl-all-day")).toBe("NFL All Day")
    expect(collectionDisplayName("laliga-golazos")).toBe("LaLiga Golazos")
    expect(collectionDisplayName("disney-pinnacle")).toBe("Disney Pinnacle")
    // The `ufc` url-slug maps to the "UFC Strike" brand name.
    expect(collectionDisplayName("ufc")).toBe("UFC Strike")
  })

  it("falls back to 'Flow' for unknown slugs", () => {
    expect(collectionDisplayName("not-a-collection")).toBe("Flow")
    expect(collectionDisplayName("")).toBe("Flow")
  })
})
