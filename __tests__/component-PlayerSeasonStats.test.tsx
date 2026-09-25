// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"

import PlayerSeasonStats from "@/components/entity/PlayerSeasonStats"
import { buildSeasonStatsTables, seasonLabel, teamSlugLabel, type SeasonStatsResult } from "@/lib/player-page-season-stats"

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
  it("a misaligned row is dropped rather than rendered askew", () => {
    const broken: SeasonStatsResult = { ...nfl, rows: [{ ...nfl.rows[0], values: ["16"] }] }
    expect(buildSeasonStatsTables(broken)).toEqual([])
  })
  it("season labels: NBA is the two-year form, NFL the year; team slugs read as names", () => {
    expect(seasonLabel("nba", 2025)).toBe("2024-25")
    expect(seasonLabel("nfl", 2025)).toBe("2025")
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
