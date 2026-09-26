import { describe, it, expect } from "vitest"
import { parseEspnStats, matchEspnSearch, baseSlug, espnStatsUrl, espnSearchUrl, chunk } from "../scripts/lib/espn-player-stats.mjs"

// The pure half of the ESPN stats feed (batch 47, 2026-09-25). Properties: a
// payload without a categories array is a FAILED read (throws), not zero rows;
// a stat line whose values do not line up with its labels is dropped, never
// stored misaligned; the search match accepts exactly ONE same-league base-name
// hit and reports why otherwise.

const PAYLOAD = {
  filters: [{ name: "league", value: "nfl" }, { name: "seasontype", value: "2" }],
  categories: [
    {
      name: "passing",
      displayName: "Passing",
      labels: ["GP", "YDS", "TD"],
      names: ["gamesPlayed", "passingYards", "passingTouchdowns"],
      statistics: [
        { season: { year: 2024, displayName: "2024" }, teamSlug: "kansas-city-chiefs", stats: ["16", "3,928", "26"] },
        { season: { year: 2025, displayName: "2025" }, teamSlug: "kansas-city-chiefs", stats: ["17", "4,100", "30"] },
        { season: { year: "x" }, teamSlug: "kansas-city-chiefs", stats: ["1", "2", "3"] }, // no year: dropped
        { season: { year: 2023 }, teamSlug: "", stats: ["16", "4,183"] }, // misaligned: dropped
      ],
    },
    { name: "", labels: ["A"], names: ["a"], statistics: [{ season: { year: 2025 }, stats: ["1"] }] }, // nameless: dropped
    { name: "rushing", displayName: "Rushing", labels: ["GP", "YDS"], names: ["gamesPlayed", "rushingYards"], statistics: [] },
  ],
}

describe("parseEspnStats", () => {
  it("shapes one row per (season, category), values as ESPN's display strings, season type from the filters", () => {
    const rows = parseEspnStats(PAYLOAD, 3139477)
    expect(rows).toEqual([
      {
        espn_id: "3139477",
        season: 2024,
        season_type: 2,
        category: "passing",
        display_name: "Passing",
        team_slug: "kansas-city-chiefs",
        is_total: false,
        labels: ["GP", "YDS", "TD"],
        names: ["gamesPlayed", "passingYards", "passingTouchdowns"],
        values: ["16", "3,928", "26"],
      },
      {
        espn_id: "3139477",
        season: 2025,
        season_type: 2,
        category: "passing",
        display_name: "Passing",
        team_slug: "kansas-city-chiefs",
        is_total: false,
        labels: ["GP", "YDS", "TD"],
        names: ["gamesPlayed", "passingYards", "passingTouchdowns"],
        values: ["17", "4,100", "30"],
      },
    ])
  })

  it("a traded season: one line per team keeps its slug, the totals line is team_slug null + is_total, duplicates collapse", () => {
    const traded = {
      filters: [{ name: "seasontype", value: "2" }],
      categories: [
        {
          name: "receiving", displayName: "Receiving", labels: ["GP"], names: ["gamesPlayed"],
          statistics: [
            { season: { year: 2024 }, teamSlug: "las-vegas-raiders", teamId: 13, stats: ["3"] },
            { season: { year: 2024 }, teamSlug: "new-york-jets", teamId: 20, stats: ["11"] },
            { season: { year: 2024 }, teamSlug: "2024 Totals", teamId: null, displayName: "2024  Totals", stats: ["14"] },
            { season: { year: 2024 }, teamSlug: "new-york-jets", teamId: 20, stats: ["11"] },
          ],
        },
      ],
    }
    const rows = parseEspnStats(traded, 16800)
    expect(rows.map((r) => [r.team_slug, r.is_total, r.values[0]])).toEqual([
      ["las-vegas-raiders", false, "3"],
      ["new-york-jets", false, "11"],
      [null, true, "14"],
    ])
  })

  it("a postseason filter is carried as season_type 3", () => {
    const rows = parseEspnStats({ ...PAYLOAD, filters: [{ name: "seasontype", value: "3" }] }, "1")
    expect(rows.every((r) => r.season_type === 3)).toBe(true)
  })

  it("THROWS on a payload without categories — a changed upstream is a failed read, not zero stats", () => {
    expect(() => parseEspnStats({ filters: [] }, "1")).toThrow(/no categories/)
    expect(() => parseEspnStats(null, "1")).toThrow(/not an object/)
  })

  it("an athlete with categories but no seasons yields zero rows (a real empty, not an error)", () => {
    expect(parseEspnStats({ categories: [{ name: "passing", labels: ["GP"], names: ["gp"], statistics: [] }] }, "1")).toEqual([])
  })
})

describe("matchEspnSearch", () => {
  const items = [
    { id: "6430", displayName: "Jimmy Butler III", sport: "basketball", league: "nba" },
    { id: "999", displayName: "Jimmy Butler", sport: "football", league: "nfl" },
  ]
  it("accepts the one same-league base-name hit, suffix-insensitively", () => {
    expect(matchEspnSearch(items, "nba", "Jimmy Butler")).toEqual({ espn_id: "6430", matched_by: "espn-search:name" })
    expect(matchEspnSearch(items, "nba", "Jimmy Butler III")).toEqual({ espn_id: "6430", matched_by: "espn-search:name" })
  })
  it("reports none and ambiguity instead of guessing", () => {
    expect(matchEspnSearch(items, "nba", "Nobody Known")).toEqual({ espn_id: null, matched_by: "unresolved:none" })
    const two = [
      { id: "1", displayName: "Marcus Morris Sr.", league: "nba" },
      { id: "2", displayName: "Marcus Morris", league: "nba" },
    ]
    expect(matchEspnSearch(two, "nba", "Marcus Morris Sr.")).toEqual({ espn_id: "1", matched_by: "espn-search:exact" })
    expect(matchEspnSearch(two, "nba", "Marcus Morris Jr.")).toEqual({ espn_id: null, matched_by: "unresolved:ambiguous:2" })
    expect(matchEspnSearch(undefined, "nba", "X")).toEqual({ espn_id: null, matched_by: "unresolved:none" })
  })
})

describe("helpers", () => {
  it("baseSlug folds accents, case, punctuation and the generational suffix", () => {
    expect(baseSlug("Nikola Jokić")).toBe("nikola-jokic")
    expect(baseSlug("Marvin Harrison Jr.")).toBe("marvin-harrison")
    expect(baseSlug("Patrick Surtain II")).toBe("patrick-surtain")
  })
  it("urls", () => {
    expect(espnStatsUrl("nfl", "3139477")).toBe("https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/3139477/stats")
    expect(espnSearchUrl("nba", "Jimmy Butler", 5)).toContain("sport=basketball")
    expect(espnSearchUrl("nba", "Jimmy Butler", 5)).toContain("query=Jimmy+Butler")
    expect(() => espnStatsUrl("mlb", "1")).toThrow(/unknown league/)
  })
  it("chunk", () => {
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]])
  })
})
