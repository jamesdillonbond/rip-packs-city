import { describe, it, expect } from "vitest"
import { fmtTeamUsd, fmtTeamCount, teamLogoUrl } from "@/lib/fan-teams-format"

// Display helpers for /my-teams. teamLogoUrl carries the real branch logic — the
// official league-specific CDN URL vs the abbreviation-badge fallback.

describe("fan-teams-format · formatters", () => {
  it("fmtTeamUsd formats or em-dashes non-finite / null", () => {
    expect(fmtTeamUsd(12345)).toBe("$12,345")
    expect(fmtTeamUsd(0)).toBe("$0")
    expect(fmtTeamUsd(null)).toBe("—")
    expect(fmtTeamUsd(undefined)).toBe("—")
    expect(fmtTeamUsd(NaN)).toBe("—")
  })

  it("fmtTeamCount formats with separators or em-dashes non-finite / null", () => {
    expect(fmtTeamCount(1500)).toBe("1,500")
    expect(fmtTeamCount(0)).toBe("0")
    expect(fmtTeamCount(null)).toBe("—")
    expect(fmtTeamCount(NaN)).toBe("—")
  })
})

describe("fan-teams-format · teamLogoUrl", () => {
  it("returns the league-specific official CDN SVG for NBA and WNBA", () => {
    expect(teamLogoUrl({ league: "NBA", external_id: "1610612757" })).toBe(
      "https://cdn.nba.com/logos/nba/1610612757/global/L/logo.svg",
    )
    expect(teamLogoUrl({ league: "WNBA", external_id: "1611661319" })).toBe(
      "https://cdn.wnba.com/logos/wnba/1611661319/global/L/logo.svg",
    )
    // case-insensitive league
    expect(teamLogoUrl({ league: "nba", external_id: "1" })).toContain("cdn.nba.com")
  })

  it("falls back to null (abbreviation badge) for other leagues or no external_id", () => {
    expect(teamLogoUrl({ league: "NFL", external_id: "99" })).toBeNull()
    expect(teamLogoUrl({ league: "NBA", external_id: null })).toBeNull()
  })
})
