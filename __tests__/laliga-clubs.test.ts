import { describe, it, expect } from "vitest"
import { getClubAbbrev, LALIGA_CLUB_ABBREVS } from "@/lib/laliga-clubs"

// Locks getClubAbbrev: known LaLiga club names map to their curated 3-letter
// abbreviation; unknown names fall back to the first 3 chars upper-cased; empty
// input returns the "???" sentinel.

describe("getClubAbbrev", () => {
  it("returns the curated abbreviation for known clubs", () => {
    expect(getClubAbbrev("FC Barcelona")).toBe("FCB")
    expect(getClubAbbrev("Real Madrid CF")).toBe("RMA")
    expect(getClubAbbrev("Athletic Club")).toBe("ATH")
  })

  it("maps both Espanyol name variants to ESP", () => {
    expect(getClubAbbrev("RCD Espanyol")).toBe("ESP")
    expect(getClubAbbrev("RCD Espanyol de Barcelona")).toBe("ESP")
  })

  it("handles the accented club names", () => {
    expect(getClubAbbrev("Atlético de Madrid")).toBe("ATM")
    expect(getClubAbbrev("UD Almería")).toBe("ALM")
  })

  it("falls back to first-3-chars upper-cased for unknown clubs", () => {
    expect(getClubAbbrev("Some Unknown FC")).toBe("SOM")
    expect(getClubAbbrev("ab")).toBe("AB")
  })

  it("returns ??? for empty input", () => {
    expect(getClubAbbrev("")).toBe("???")
  })

  it("every mapped value is the curated abbreviation for its key", () => {
    for (const [name, abbrev] of Object.entries(LALIGA_CLUB_ABBREVS)) {
      expect(getClubAbbrev(name)).toBe(abbrev)
    }
  })
})
