import { describe, it, expect } from "vitest"
import { parseEspnStats, matchEspnSearch, espnSearchHits, baseSlug, espnStatsUrl, espnSearchUrl, slugToQuery, chunk } from "../scripts/lib/espn-player-stats.mjs"

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

describe("matchEspnSearch — ESPN search v2 (batch 56: retired players and the WNBA)", () => {
  // the v2 shape: results[].contents[] with the athlete id inside uid and the league in defaultLeagueSlug
  const v2 = (contents: Array<Record<string, unknown>>) => ({ results: [{ type: "player", contents: contents.map((c) => ({ type: "player", ...c })) }] })
  const butler = v2([
    { uid: "s:40~l:46~a:6430", displayName: "Jimmy Butler III", sport: "basketball", defaultLeagueSlug: "nba", subtitle: "Golden State Warriors" },
    { uid: "s:20~l:28~a:999", displayName: "Jimmy Butler", sport: "football", defaultLeagueSlug: "nfl" },
    { uid: "s:40~l:41~a:777", displayName: "Jimmy Butler", sport: "basketball", defaultLeagueSlug: "mens-college-basketball" },
  ])
  it("accepts the one same-league base-name hit, suffix-insensitively, and says which ESPN league it lives in", () => {
    expect(matchEspnSearch(butler, "nba", "Jimmy Butler")).toEqual({ espn_id: "6430", espn_league: "nba", matched_by: "espn-search:name" })
    expect(matchEspnSearch(butler, "nba", "Jimmy Butler III")).toEqual({ espn_id: "6430", espn_league: "nba", matched_by: "espn-search:name" })
  })
  it("a Top Shot WNBA player resolves under league nba to her wnba id; college and other sports never do", () => {
    const wilson = v2([
      { uid: "s:40~l:59~a:3149391", displayName: "A'ja Wilson", sport: "basketball", defaultLeagueSlug: "wnba", subtitle: "Las Vegas Aces" },
      { uid: "s:40~l:54~a:4412077", displayName: "A'Ja Wilson", sport: "basketball", defaultLeagueSlug: "womens-college-basketball" },
    ])
    expect(matchEspnSearch(wilson, "nba", "A'ja Wilson")).toEqual({ espn_id: "3149391", espn_league: "wnba", matched_by: "espn-search:name" })
    // an NFL identity never takes a basketball hit
    expect(matchEspnSearch(wilson, "nfl", "A'ja Wilson")).toEqual({ espn_id: null, espn_league: null, matched_by: "unresolved:none" })
  })
  it("a player ESPN files on a G League roster (nba-development, same athlete id) is an NBA hit", () => {
    const fultz = v2([{ uid: "s:40~l:69~a:4066636", displayName: "Markelle Fultz", sport: "basketball", defaultLeagueSlug: "nba-development", subtitle: "Raptors 905" }])
    expect(matchEspnSearch(fultz, "nba", "Markelle Fultz")).toEqual({ espn_id: "4066636", espn_league: "nba", matched_by: "espn-search:name" })
  })
  it("a retired player's hit (the v3 search never returned one) is taken like any other", () => {
    const pierce = v2([{ uid: "s:40~l:46~a:662", displayName: "Paul Pierce", sport: "basketball", defaultLeagueSlug: "nba", subtitle: "LA Clippers" }])
    expect(matchEspnSearch(pierce, "nba", "Paul Pierce")).toEqual({ espn_id: "662", espn_league: "nba", matched_by: "espn-search:name" })
  })
  it("reports none and ambiguity instead of guessing — a same-name pair is never settled by league or team", () => {
    expect(matchEspnSearch(butler, "nba", "Nobody Known")).toEqual({ espn_id: null, espn_league: null, matched_by: "unresolved:none" })
    const two = v2([
      { uid: "s:40~l:46~a:1", displayName: "Marcus Morris Sr.", defaultLeagueSlug: "nba", sport: "basketball" },
      { uid: "s:40~l:46~a:2", displayName: "Marcus Morris", defaultLeagueSlug: "nba", sport: "basketball" },
    ])
    expect(matchEspnSearch(two, "nba", "Marcus Morris Sr.")).toEqual({ espn_id: "1", espn_league: "nba", matched_by: "espn-search:exact" })
    expect(matchEspnSearch(two, "nba", "Marcus Morris Jr.")).toEqual({ espn_id: null, espn_league: null, matched_by: "unresolved:ambiguous:2" })
    expect(matchEspnSearch(undefined, "nba", "X")).toEqual({ espn_id: null, espn_league: null, matched_by: "unresolved:none" })
    expect(matchEspnSearch({ results: [] }, "nba", "X")).toEqual({ espn_id: null, espn_league: null, matched_by: "unresolved:none" })
  })
  it("a hit without an athlete id in its uid is skipped, not taken with an empty id; the batch-47 items shape still parses", () => {
    expect(espnSearchHits(v2([{ uid: "s:40~l:46", displayName: "No Id", defaultLeagueSlug: "nba" }]))).toEqual([])
    expect(espnSearchHits({ items: [{ id: "6430", displayName: "Jimmy Butler III", sport: "basketball", league: "nba" }] })).toEqual([
      { id: "6430", displayName: "Jimmy Butler III", league: "nba", sport: "basketball", team: null },
    ])
  })
})

describe("helpers", () => {
  it("baseSlug folds accents, case, punctuation and the generational suffix", () => {
    expect(baseSlug("Nikola Jokić")).toBe("nikola-jokic")
    expect(baseSlug("Marvin Harrison Jr.")).toBe("marvin-harrison")
    expect(baseSlug("Patrick Surtain II")).toBe("patrick-surtain")
  })
  it("urls: the stats path is the ESPN league's (wnba under basketball), the search is v2", () => {
    expect(espnStatsUrl("nfl", "3139477")).toBe("https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/3139477/stats")
    expect(espnStatsUrl("nba", "3149391", "wnba")).toBe("https://site.web.api.espn.com/apis/common/v3/sports/basketball/wnba/athletes/3149391/stats")
    expect(espnStatsUrl("nba", "662", "nba")).toContain("/basketball/nba/athletes/662/")
    expect(() => espnStatsUrl("nfl", "1", "wnba")).toThrow(/not an ESPN league of nfl/)
    expect(espnSearchUrl("nba", "Jimmy Butler", 5)).toBe("https://site.web.api.espn.com/apis/search/v2?query=Jimmy+Butler&type=player&limit=5")
    expect(() => espnStatsUrl("mlb", "1")).toThrow(/unknown league/)
    expect(slugToQuery("stephen-curry")).toBe("stephen curry")
  })
  it("chunk", () => {
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]])
  })
})
