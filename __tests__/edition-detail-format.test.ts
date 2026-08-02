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
  it("names each collection URL slug the [collection] route can receive", () => {
    // Keyed on the URL slug the edition page gets as its route param. UFC has
    // two live forms — canonical "ufc" (lib/collections.ts id + sitemap) and the
    // "ufc-strike" alias (/moment links) — so BOTH must be present.
    expect(Object.keys(ASK_LABEL).sort()).toEqual(
      ["disney-pinnacle", "laliga-golazos", "nba-top-shot", "nfl-all-day", "ufc", "ufc-strike"].sort(),
    )
  })
  it("labels UFC as 'UFC ask' on the CANONICAL 'ufc' slug the route receives", () => {
    // Regression: the app's own UFC nav and the sitemap use "/ufc/edition/...",
    // so `ASK_LABEL[collection]` is looked up with "ufc". Before the fix only
    // "ufc-strike" was keyed, so every canonical UFC edition page fell through to
    // the generic "Floor ask". Both forms must resolve to the UFC label.
    expect(ASK_LABEL["ufc"]).toBe("UFC ask")
    expect(ASK_LABEL["ufc-strike"]).toBe("UFC ask")
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
