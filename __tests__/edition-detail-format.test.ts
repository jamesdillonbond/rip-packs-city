import { describe, it, expect } from "vitest"
import { isTopShotFossilSlug, ASK_LABEL, notableTagLabel } from "@/lib/edition-detail-format"

describe("isTopShotFossilSlug", () => {
  it("flags a hyphenated (uuid:uuid) slug on Top Shot as a fossil", () => {
    expect(isTopShotFossilSlug("nba-top-shot", "abc-123:def-456")).toBe(true)
  })
  it("does NOT flag the canonical setID:playID form (no hyphen)", () => {
    expect(isTopShotFossilSlug("nba-top-shot", "123:456")).toBe(false)
  })
  it("is scoped to Top Shot — never flags UFC's uuid-like ids", () => {
    expect(isTopShotFossilSlug("ufc-strike", "abc-123:def-456")).toBe(false)
    expect(isTopShotFossilSlug("nfl-all-day", "abc-123")).toBe(false)
  })
})

describe("ASK_LABEL", () => {
  it("never says 'Top Shot ask' on a non-Top-Shot collection", () => {
    for (const [slug, label] of Object.entries(ASK_LABEL)) {
      if (slug !== "nba-top-shot") expect(label).not.toContain("Top Shot")
    }
  })
  it("labels Top Shot as 'Top Shot ask'", () => {
    expect(ASK_LABEL["nba-top-shot"]).toBe("Top Shot ask")
  })
  it("names each of the five spec'd collection slugs", () => {
    // Keyed on Trevor's spec URL slugs (incl. "ufc-strike"); the map's job is a
    // correct collection-specific label wherever a key is present.
    expect(Object.keys(ASK_LABEL).sort()).toEqual(
      ["disney-pinnacle", "laliga-golazos", "nba-top-shot", "nfl-all-day", "ufc-strike"].sort(),
    )
  })
})

describe("notableTagLabel", () => {
  it("maps the known notable-serial tags", () => {
    expect(notableTagLabel("#1")).toBe("Serial #1")
    expect(notableTagLabel("jersey")).toBe("Jersey Match")
    expect(notableTagLabel("last_mint")).toBe("Perfect Serial")
  })
  it("humanizes an unknown tag by replacing underscores", () => {
    expect(notableTagLabel("some_other_tag")).toBe("some other tag")
  })
})
