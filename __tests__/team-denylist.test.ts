import { describe, it, expect } from "vitest"
import { isExhibitionTeamSlug, EXHIBITION_TEAM_SLUGS } from "@/lib/team-denylist"

// Locks the exhibition/all-star team denylist: isExhibitionTeamSlug matches the
// 12 canonical junk slugs (trimming + lowercasing the input first) and keeps
// real/historical franchises (which have no teams_master row) off the denylist.

describe("isExhibitionTeamSlug", () => {
  it("returns true for every denylisted exhibition slug", () => {
    for (const slug of EXHIBITION_TEAM_SLUGS) {
      expect(isExhibitionTeamSlug(slug)).toBe(true)
    }
  })

  it("normalizes case and surrounding whitespace before matching", () => {
    expect(isExhibitionTeamSlug("TEAM-LEBRON")).toBe(true)
    expect(isExhibitionTeamSlug("  team-durant  ")).toBe(true)
    expect(isExhibitionTeamSlug("Eastern-Conference-All-Stars")).toBe(true)
  })

  it("returns false for real / historical franchises that legitimately lack a teams_master row", () => {
    expect(isExhibitionTeamSlug("portland-trail-blazers")).toBe(false)
    expect(isExhibitionTeamSlug("new-york-liberty")).toBe(false)
    expect(isExhibitionTeamSlug("seattle-supersonics")).toBe(false)
    expect(isExhibitionTeamSlug("")).toBe(false)
  })

  it("denylist is exactly the documented 12 slugs", () => {
    expect(EXHIBITION_TEAM_SLUGS.size).toBe(12)
  })
})
