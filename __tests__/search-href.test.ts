import { describe, it, expect } from "vitest"
import { buildSearchHref, searchKindLabel } from "@/lib/search/href"

// A wrong href here produces a search result that 404s on click — invisible to
// typecheck, and worse than having no search. These pin the four route shapes
// against the segments the app actually mounts.

describe("buildSearchHref", () => {
  it("builds the four known entity routes", () => {
    expect(buildSearchHref("player", "nba-top-shot", "damian-lillard")).toBe(
      "/nba-top-shot/player/damian-lillard"
    )
    expect(buildSearchHref("set", "nba-top-shot", "metallic-gold-le")).toBe(
      "/nba-top-shot/set/metallic-gold-le"
    )
    expect(buildSearchHref("team", "nba-top-shot", "portland-trail-blazers")).toBe(
      "/nba-top-shot/team/portland-trail-blazers"
    )
    expect(buildSearchHref("edition", "nfl-all-day", "abc-123")).toBe(
      "/nfl-all-day/edition/abc-123"
    )
  })

  it("encodes the ':' in an edition key so it survives the router", () => {
    // Top Shot edition keys are 'setID:playID', and parallels add '::n'.
    expect(buildSearchHref("edition", "nba-top-shot", "8:145")).toBe(
      "/nba-top-shot/edition/8%3A145"
    )
    expect(buildSearchHref("edition", "nba-top-shot", "90:2964::1")).toBe(
      "/nba-top-shot/edition/90%3A2964%3A%3A1"
    )
  })

  it("returns null for an unknown kind rather than guessing a path", () => {
    // If a future RPC arm adds a kind, it must fail closed — not ship a dead link.
    expect(buildSearchHref("series", "nba-top-shot", "series-4")).toBeNull()
    expect(buildSearchHref("", "nba-top-shot", "x")).toBeNull()
  })

  it("returns null on an empty collection or slug", () => {
    expect(buildSearchHref("player", "", "damian-lillard")).toBeNull()
    expect(buildSearchHref("player", "nba-top-shot", "")).toBeNull()
  })

  it("does not resolve inherited Object prototype keys as kinds", () => {
    // MAP[urlParam] on a plain object literal resolves 'constructor' to a
    // truthy Object.prototype member — the D22 crash class. The lookup is
    // hasOwnProperty-guarded, so these must be null, not a route.
    expect(buildSearchHref("constructor", "nba-top-shot", "x")).toBeNull()
    expect(buildSearchHref("__proto__", "nba-top-shot", "x")).toBeNull()
    expect(buildSearchHref("toString", "nba-top-shot", "x")).toBeNull()
  })
})

describe("searchKindLabel", () => {
  it("uses sports vocabulary by default", () => {
    expect(searchKindLabel("player", false)).toBe("PLAYER")
    expect(searchKindLabel("team", false)).toBe("TEAM")
  })

  it("switches to Pinnacle vocabulary (character / franchise)", () => {
    expect(searchKindLabel("player", true)).toBe("CHARACTER")
    expect(searchKindLabel("team", true)).toBe("FRANCHISE")
  })

  it("labels an edition as MOMENT, the user-facing word", () => {
    expect(searchKindLabel("edition", false)).toBe("MOMENT")
    expect(searchKindLabel("set", false)).toBe("SET")
  })

  it("falls back to an uppercased kind for anything unrecognised", () => {
    expect(searchKindLabel("series", false)).toBe("SERIES")
  })
})
