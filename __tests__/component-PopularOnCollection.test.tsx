// @vitest-environment jsdom
import { describe, it, expect } from "vitest"
import { distinctSlugLinks } from "@/components/entity/PopularOnCollection"

// PopularOnCollection's DEFAULT export is an ASYNC SERVER COMPONENT
// (`export default async function` with top-level `await` over supabaseAdmin) —
// it CANNOT be rendered in jsdom. Only its exported pure helper
// `distinctSlugLinks` is unit-testable, so this file covers that helper's
// branches: dedupe, cap, null/empty filtering, the exhibition-team drop, and the
// slug/href shaping (slugifyName roundtrip + encodeURIComponent).

describe("PopularOnCollection.distinctSlugLinks", () => {
  it("dedupes by slug and preserves first-seen order", () => {
    const out = distinctSlugLinks(
      ["Damian Lillard", "damian lillard", "Anfernee Simons"],
      "nba-top-shot",
      "player",
      12,
    )
    expect(out.map((l) => l.label)).toEqual(["Damian Lillard", "Anfernee Simons"])
    expect(out[0].href).toBe("/nba-top-shot/player/damian-lillard")
  })

  it("caps the output at `cap` distinct links", () => {
    const out = distinctSlugLinks(
      ["Alpha", "Bravo", "Charlie", "Delta"],
      "nba-top-shot",
      "set",
      2,
    )
    expect(out).toHaveLength(2)
    expect(out.map((l) => l.label)).toEqual(["Alpha", "Bravo"])
  })

  it("skips null / undefined / blank / whitespace-only names", () => {
    const out = distinctSlugLinks(
      [null, undefined, "", "   ", "Real Name"],
      "nfl-all-day",
      "player",
      12,
    )
    expect(out).toHaveLength(1)
    expect(out[0].label).toBe("Real Name")
  })

  it("drops exhibition/all-star team slugs only when dropExhibition is set", () => {
    const names = ["Team LeBron", "Portland Trail Blazers"]
    const dropped = distinctSlugLinks(names, "nba-top-shot", "team", 10, true)
    expect(dropped.map((l) => l.label)).toEqual(["Portland Trail Blazers"])
    // Without the flag, the exhibition roster is kept.
    const kept = distinctSlugLinks(names, "nba-top-shot", "team", 10, false)
    expect(kept.map((l) => l.label)).toEqual(["Team LeBron", "Portland Trail Blazers"])
  })

  it("builds an encoded href for each segment", () => {
    const out = distinctSlugLinks(["Kevin Durant"], "nfl-all-day", "series", 12)
    expect(out[0].href).toBe("/nfl-all-day/series/kevin-durant")
  })

  it("returns an empty list when there are no usable names", () => {
    expect(distinctSlugLinks([null, "", "   "], "ufc-strike", "set", 12)).toEqual([])
  })
})
