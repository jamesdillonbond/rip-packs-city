// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"

import PlayerSeasonStats from "@/components/entity/PlayerSeasonStats"
import { buildSeasonStatsTables, isZeroLike, seasonLabel, teamSlugLabel, type SeasonStatRow, type SeasonStatsResult } from "@/lib/player-page-season-stats"

// The player page's Season stats section (batch 48, 2026-09-25). Pins the
// THREE states the RPC hands back and that the component must keep apart:
// read failed → SectionUnavailable; NULL (no feed for this player) → nothing;
// keyed but empty → "no stats yet"; rows → one table per category, seasons
// newest first, ESPN's values verbatim.

afterEach(cleanup)

const nfl: SeasonStatsResult = {
  league: "nfl",
  espn_id: "3139477",
  display_name: "Patrick Mahomes",
  stats_refreshed_at: "2026-09-25T23:50:00.000Z",
  rows_refreshed_at: "2026-09-25T23:50:00.000Z",
  rows: [
    { season: 2024, season_type: 2, category: "rushing", display_name: "Rushing", team_slug: "kansas-city-chiefs", labels: ["GP", "YDS"], names: ["gamesPlayed", "rushingYards"], values: ["16", "307"] },
    { season: 2024, season_type: 2, category: "passing", display_name: "Passing", team_slug: "kansas-city-chiefs", labels: ["GP", "YDS", "TD"], names: ["gamesPlayed", "passingYards", "passingTouchdowns"], values: ["16", "3,928", "26"] },
    { season: 2025, season_type: 2, category: "passing", display_name: "Passing", team_slug: "kansas-city-chiefs", labels: ["GP", "YDS", "TD", "QBR"], names: ["gamesPlayed", "passingYards", "passingTouchdowns", "QBRating"], values: ["17", "4,100", "30", "71.2"] },
  ],
}

describe("buildSeasonStatsTables", () => {
  it("one table per category in the league's order, seasons newest first, older seasons mapped by stat NAME onto the newest labels", () => {
    const tables = buildSeasonStatsTables(nfl)
    expect(tables.map((t) => t.category)).toEqual(["passing", "rushing"])
    const passing = tables[0]
    expect(passing.labels).toEqual(["GP", "YDS", "TD", "QBR"])
    expect(passing.seasons.map((s) => s.season)).toEqual([2025, 2024])
    expect(passing.seasons[0].values).toEqual(["17", "4,100", "30", "71.2"])
    // 2024 had no QBR column: it reads "—", never a value shifted into the wrong column
    expect(passing.seasons[1].values).toEqual(["16", "3,928", "26", "—"])
    expect(passing.seasons[0].team).toBe("Kansas City Chiefs")
  })
  it("a traded season shows its TOTALS line labelled with both teams, not two half-seasons; without a total, each team's line stays", () => {
    const traded: SeasonStatsResult = {
      ...nfl,
      rows: [
        { season: 2024, season_type: 2, category: "receiving", display_name: "Receiving", team_slug: "las-vegas-raiders", is_total: false, labels: ["GP"], names: ["gamesPlayed"], values: ["3"] },
        { season: 2024, season_type: 2, category: "receiving", display_name: "Receiving", team_slug: "new-york-jets", is_total: false, labels: ["GP"], names: ["gamesPlayed"], values: ["11"] },
        { season: 2024, season_type: 2, category: "receiving", display_name: "Receiving", team_slug: null, is_total: true, labels: ["GP"], names: ["gamesPlayed"], values: ["14"] },
        { season: 2023, season_type: 2, category: "receiving", display_name: "Receiving", team_slug: "las-vegas-raiders", is_total: false, labels: ["GP"], names: ["gamesPlayed"], values: ["17"] },
        { season: 2022, season_type: 2, category: "receiving", display_name: "Receiving", team_slug: "team-a", is_total: false, labels: ["GP"], names: ["gamesPlayed"], values: ["5"] },
        { season: 2022, season_type: 2, category: "receiving", display_name: "Receiving", team_slug: "team-b", is_total: false, labels: ["GP"], names: ["gamesPlayed"], values: ["9"] },
      ],
    }
    const [t] = buildSeasonStatsTables(traded)
    expect(t.seasons.map((s) => [s.season, s.team, s.values[0]])).toEqual([
      [2024, "Las Vegas Raiders / New York Jets", "14"],
      [2023, "Las Vegas Raiders", "17"],
      [2022, "Team A", "5"],
      [2022, "Team B", "9"],
    ])
  })

  it("a category whose counting columns are all zero (a receiver's 'Passing': GP 14, RTG 39.6, everything else 0) is not rendered; a single real count keeps it", () => {
    const line = (category: string, names: string[], values: string[]): SeasonStatRow => ({
      season: 2025, season_type: 2, category, display_name: category, team_slug: "x", is_total: false, labels: names, names, values,
    })
    const wr: SeasonStatsResult = {
      ...nfl,
      rows: [
        line("passing", ["gamesPlayed", "completions", "passingAttempts", "completionPct", "passingYards", "QBRating"], ["14", "0", "0", "0.0", "0", "39.6"]),
        line("receiving", ["gamesPlayed", "receptions", "receivingYards"], ["14", "60", "789"]),
        line("rushing", ["gamesPlayed", "rushingAttempts", "rushingYards"], ["14", "0", "1"]),
      ],
    }
    expect(buildSeasonStatsTables(wr).map((t) => t.category)).toEqual(["rushing", "receiving"])
    expect(isZeroLike("0")).toBe(true)
    expect(isZeroLike("0.0")).toBe(true)
    expect(isZeroLike("0-0")).toBe(true)
    expect(isZeroLike("-")).toBe(true)
    expect(isZeroLike("10")).toBe(false)
    expect(isZeroLike("0.5")).toBe(false)
    expect(isZeroLike("9.3-18.1")).toBe(false)
  })

  it("a misaligned row is dropped rather than rendered askew", () => {
    const broken: SeasonStatsResult = { ...nfl, rows: [{ ...nfl.rows[0], values: ["16"] }] }
    expect(buildSeasonStatsTables(broken)).toEqual([])
  })
  it("season labels: NBA is the two-year form, NFL the year; team slugs read as names", () => {
    expect(seasonLabel("nba", 2025)).toBe("2024-25")
    expect(seasonLabel("nfl", 2025)).toBe("2025")
    // a Top Shot WNBA player (league nba, espn_league wnba): a calendar-year season (batch 56)
    expect(seasonLabel("wnba", 2026)).toBe("2026")
    const wnba: SeasonStatsResult = {
      ...nfl, league: "nba", espn_league: "wnba", espn_id: "3149391", display_name: "A'ja Wilson",
      rows: [{ season: 2026, season_type: 2, category: "averages", display_name: "Averages", team_slug: "las-vegas-aces", is_total: false, labels: ["GP", "PTS"], names: ["gamesPlayed", "avgPoints"], values: ["40", "23.4"] }],
    }
    expect(buildSeasonStatsTables(wnba)[0].seasons[0].seasonLabel).toBe("2026")
    expect(buildSeasonStatsTables({ ...wnba, espn_league: "nba" })[0].seasons[0].seasonLabel).toBe("2025-26")
    expect(teamSlugLabel("san-francisco-49ers")).toBe("San Francisco 49ers")
    expect(teamSlugLabel(null)).toBeNull()
  })
})

describe("<PlayerSeasonStats>", () => {
  it("read failed → the section is there and says UNAVAILABLE, not empty", () => {
    render(<PlayerSeasonStats result={null} ok={false} playerName="Patrick Mahomes" />)
    expect(screen.getByText("Season Stats")).toBeTruthy()
    expect(screen.queryByTestId("season-stats-empty")).toBeNull()
    expect(document.body.textContent).toMatch(/unavailable|couldn|not available/i)
  })
  it("no feed for this player (NULL) → renders nothing at all", () => {
    const { container } = render(<PlayerSeasonStats result={null} ok={true} playerName="Someone" />)
    expect(container.innerHTML).toBe("")
  })
  it("keyed but no rows yet → says so, and never claims a zero", () => {
    render(<PlayerSeasonStats result={{ ...nfl, rows: [], rows_refreshed_at: null }} ok={true} playerName="Patrick Mahomes" />)
    expect(screen.getByTestId("season-stats-empty").textContent).toMatch(/No season stats from the feed yet/)
    expect(screen.getByTestId("season-stats-source").textContent).toMatch(/ESPN/)
  })
  it("no refresh stamp at all → the source line is just ESPN; a line without a team shows no team", () => {
    const bare: SeasonStatsResult = {
      ...nfl,
      stats_refreshed_at: null,
      rows_refreshed_at: null,
      rows: [{ season: 2025, season_type: 2, category: "passing", display_name: "Passing", team_slug: null, is_total: false, labels: ["YDS"], names: ["passingYards"], values: ["4,100"] }],
    }
    render(<PlayerSeasonStats result={bare} ok={true} playerName="P" />)
    expect(screen.getByTestId("season-stats-source").textContent).toBe("ESPN")
    const passing = screen.getByTestId("season-stats-passing")
    expect(passing.textContent).toContain("4,100")
    expect(passing.querySelectorAll("tbody tr").length).toBe(1)
    expect(passing.querySelectorAll("tbody tr td")[0].querySelectorAll("span").length).toBe(1)
  })
  it("the identity's stamp stands in when no row carries one", () => {
    render(<PlayerSeasonStats result={{ ...nfl, rows: [], rows_refreshed_at: null, stats_refreshed_at: "2026-09-25T20:00:00.000Z" }} ok={true} playerName="P" />)
    expect(screen.getByTestId("season-stats-source").textContent).toMatch(/ESPN · refreshed/)
  })

  it("rows → tables with ESPN's values verbatim and the source line", () => {
    render(<PlayerSeasonStats result={nfl} ok={true} playerName="Patrick Mahomes" />)
    const passing = screen.getByTestId("season-stats-passing")
    expect(passing.textContent).toContain("4,100")
    expect(passing.textContent).toContain("2025")
    expect(passing.textContent).toContain("Kansas City Chiefs")
    expect(screen.getByTestId("season-stats-rushing").textContent).toContain("307")
    expect(screen.getByTestId("season-stats-source").textContent).toMatch(/ESPN · refreshed/)
    expect(screen.queryByTestId("season-stats-empty")).toBeNull()
  })
})
