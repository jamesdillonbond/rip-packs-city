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
  // RE-PINNED 2026-09-29: the official logo now comes through our same-origin rasterizing route,
  // because Chrome fails cdn.nba.com / cdn.wnba.com directly (ERR_HTTP2_PROTOCOL_ERROR).
  it("returns the league-specific official logo, via the same-origin route, for NBA and WNBA", () => {
    expect(teamLogoUrl({ league: "NBA", external_id: "1610612757" })).toBe("/api/public/team-logo/nba/1610612757")
    expect(teamLogoUrl({ league: "WNBA", external_id: "1611661319" })).toBe("/api/public/team-logo/wnba/1611661319")
    // case-insensitive league
    expect(teamLogoUrl({ league: "nba", external_id: "1" })).toBe("/api/public/team-logo/nba/1")
    // no direct hotlink to the CDN Chrome cannot reach
    expect(teamLogoUrl({ league: "NBA", external_id: "1610612757" })).not.toContain("cdn.nba.com")
  })

  it("falls back to null (abbreviation badge) for other leagues or no external_id", () => {
    expect(teamLogoUrl({ league: "NFL", external_id: "99" })).toBeNull()
    expect(teamLogoUrl({ league: "NBA", external_id: null })).toBeNull()
  })
})
