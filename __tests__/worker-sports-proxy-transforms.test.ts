import { describe, it, expect } from "vitest"
import {
  dateInETFromMs,
  dateInETFromIso,
  parseCompetitionTeams,
  parseMsJsonDate,
  mapStatus,
  extractOpponent,
  nbaSeasonStringFromETDate,
  nbaSeasonTypeFromETDate,
  buildPlayerStatsUrl,
} from "@/workers/sports-proxy/transforms"

// Pins the pure DK/NBA transforms extracted from workers/sports-proxy/index.ts.
// These shape the DraftKings projections + NBA rolling-stats feeds (Fast Break /
// Road to the Ring consume them) and ran in no CI job before extraction.

describe("dateInETFromMs / dateInETFromIso", () => {
  it("formats an instant as its US-Eastern calendar date", () => {
    // 2026-01-15T17:00Z → 12:00 EST → same day
    expect(dateInETFromMs(Date.parse("2026-01-15T17:00:00Z"))).toBe("2026-01-15")
  })
  it("rolls back across the ET midnight boundary (early-UTC instant is the prior ET day)", () => {
    // 2026-01-15T02:00Z → 21:00 EST on the 14th
    expect(dateInETFromMs(Date.parse("2026-01-15T02:00:00Z"))).toBe("2026-01-14")
  })
  it("dateInETFromIso returns null for null/empty/invalid input", () => {
    expect(dateInETFromIso(null)).toBeNull()
    expect(dateInETFromIso(undefined)).toBeNull()
    expect(dateInETFromIso("")).toBeNull()
    expect(dateInETFromIso("not-a-date")).toBeNull()
  })
  it("dateInETFromIso delegates to dateInETFromMs for a valid ISO string", () => {
    expect(dateInETFromIso("2026-01-15T17:00:00Z")).toBe("2026-01-15")
  })
})

describe("parseCompetitionTeams", () => {
  it("parses the '@' form (right token is home)", () => {
    expect(parseCompetitionTeams("MIN @ SAS")).toEqual({ homeAbbr: "SAS", awayAbbr: "MIN" })
  })
  it("parses the 'vs' and 'vs.' forms", () => {
    expect(parseCompetitionTeams("MIN vs SAS")).toEqual({ homeAbbr: "SAS", awayAbbr: "MIN" })
    expect(parseCompetitionTeams("MIN vs. SAS")).toEqual({ homeAbbr: "SAS", awayAbbr: "MIN" })
  })
  it("uppercases lowercase input", () => {
    expect(parseCompetitionTeams("min @ sas")).toEqual({ homeAbbr: "SAS", awayAbbr: "MIN" })
  })
  it("returns nulls for empty / unparseable names", () => {
    expect(parseCompetitionTeams(null)).toEqual({ homeAbbr: null, awayAbbr: null })
    expect(parseCompetitionTeams(undefined)).toEqual({ homeAbbr: null, awayAbbr: null })
    expect(parseCompetitionTeams("three team scramble")).toEqual({ homeAbbr: null, awayAbbr: null })
  })
})

describe("parseMsJsonDate", () => {
  it("extracts the epoch-ms from the /Date(...)/ form", () => {
    expect(parseMsJsonDate("/Date(1699999999999)/")).toBe(1699999999999)
  })
  it("returns null for missing / non-matching input", () => {
    expect(parseMsJsonDate(undefined)).toBeNull()
    expect(parseMsJsonDate("")).toBeNull()
    expect(parseMsJsonDate("2026-01-15")).toBeNull()
  })
})

describe("mapStatus", () => {
  it("maps known DK codes to the app vocabulary", () => {
    expect(mapStatus("NONE")).toBe("ACTIVE")
    expect(mapStatus("Q")).toBe("QUESTIONABLE")
    expect(mapStatus("GTD")).toBe("QUESTIONABLE")
    expect(mapStatus("O")).toBe("OUT")
    expect(mapStatus("OUT")).toBe("OUT")
    expect(mapStatus("IR")).toBe("INACTIVE")
  })
  it("is case-insensitive and trims", () => {
    expect(mapStatus("  none  ")).toBe("ACTIVE")
  })
  it("passes through an unknown status verbatim (original casing)", () => {
    expect(mapStatus("Probable")).toBe("Probable")
  })
  it("returns null for null/empty", () => {
    expect(mapStatus(null)).toBeNull()
    expect(mapStatus(undefined)).toBeNull()
    expect(mapStatus("   ")).toBeNull()
  })
})

describe("extractOpponent", () => {
  it("returns the other team for either side of the matchup", () => {
    expect(extractOpponent("PHI @ NYK", "PHI")).toBe("NYK")
    expect(extractOpponent("PHI @ NYK", "NYK")).toBe("PHI")
    expect(extractOpponent("PHI vs NYK", "phi")).toBe("NYK")
  })
  it("returns null when the team isn't in the matchup", () => {
    expect(extractOpponent("PHI @ NYK", "BOS")).toBeNull()
  })
  it("returns null on missing inputs / unparseable name", () => {
    expect(extractOpponent(undefined, "PHI")).toBeNull()
    expect(extractOpponent("PHI @ NYK", null)).toBeNull()
    expect(extractOpponent("some words", "PHI")).toBeNull()
  })
})

describe("nbaSeasonStringFromETDate", () => {
  it("maps Oct–Dec to the season starting that year", () => {
    expect(nbaSeasonStringFromETDate("2026-10-15")).toBe("2026-27")
    expect(nbaSeasonStringFromETDate("2026-12-31")).toBe("2026-27")
  })
  it("maps Jan–Sep to the season that started the prior year", () => {
    expect(nbaSeasonStringFromETDate("2026-01-15")).toBe("2025-26")
    expect(nbaSeasonStringFromETDate("2026-06-01")).toBe("2025-26")
  })
  it("zero-pads the end-year", () => {
    expect(nbaSeasonStringFromETDate("2000-11-01")).toBe("2000-01")
  })
})

describe("nbaSeasonTypeFromETDate", () => {
  it("treats mid-April through June as Playoffs", () => {
    expect(nbaSeasonTypeFromETDate("2026-04-15")).toBe("Playoffs")
    expect(nbaSeasonTypeFromETDate("2026-05-01")).toBe("Playoffs")
    expect(nbaSeasonTypeFromETDate("2026-06-30")).toBe("Playoffs")
  })
  it("treats early April and the rest of the year as Regular Season", () => {
    expect(nbaSeasonTypeFromETDate("2026-04-14")).toBe("Regular Season")
    expect(nbaSeasonTypeFromETDate("2026-01-15")).toBe("Regular Season")
    expect(nbaSeasonTypeFromETDate("2026-07-01")).toBe("Regular Season")
  })
})

describe("buildPlayerStatsUrl", () => {
  it("threads Season + SeasonType and keeps the required params filled", () => {
    const url = new URL(buildPlayerStatsUrl("2025-26", "Playoffs"))
    expect(url.origin + url.pathname).toBe("https://stats.nba.com/stats/leaguedashplayerstats")
    expect(url.searchParams.get("Season")).toBe("2025-26")
    expect(url.searchParams.get("SeasonType")).toBe("Playoffs")
    expect(url.searchParams.get("LastNGames")).toBe("5")
    expect(url.searchParams.get("PerMode")).toBe("PerGame")
    expect(url.searchParams.get("LeagueID")).toBe("00")
    // a param that must be present-but-empty
    expect(url.searchParams.has("VsConference")).toBe(true)
    expect(url.searchParams.get("VsConference")).toBe("")
  })
})
