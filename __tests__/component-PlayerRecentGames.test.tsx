// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { readFileSync } from "node:fs"
import { render, cleanup, screen } from "@testing-library/react"

import PlayerRecentGames, { gameMoveCell } from "@/components/entity/PlayerRecentGames"
import type { RecentGame, RecentGamesResult } from "@/lib/player-recent-games"

// The player page's Recent Games section (2026-11-08). Pins the FOUR states the RPC hands
// back and the component must keep apart — read failed → SectionUnavailable; no feed or two
// athletes behind one key → nothing (never merged, never "did not play"); linked but empty →
// "no games yet"; games → one row each — plus the two claims the numbers cannot carry: supply
// is named only when it is a real share of the move, and one game is not evidence.

afterEach(cleanup)

const LUKA: RecentGame = {
  date: "2026-11-06", league: "nba", opponent: "POR", is_home: true, did_not_play: false, minutes: 38,
  fantasy_points: 69.75,
  stats: { line: { points: "53", rebounds: "5", assists: "5", steals: "1", blocks: "0", minutes: "38" } },
  mcap_before: 1155175.21, mcap_after: 1211758.47, held_before: 220792, held_after: 220796,
}
const DNP: RecentGame = { ...LUKA, date: "2026-11-02", opponent: "LAL", is_home: false, did_not_play: true, fantasy_points: null, stats: null, mcap_before: null }

const result = (over: Partial<RecentGamesResult> = {}): RecentGamesResult => ({
  linked: 1, espn_ids: ["3945274"], games: [LUKA, DNP], season_avg_fp: 71.55, games_in_season: 5,
  first_game_date: "2026-10-30", mcap_now: 1211868.16, ...over,
})

describe("PlayerRecentGames — four states", () => {
  it("a failed read is unavailable — never 'no games'", () => {
    render(<PlayerRecentGames result={null} ok={false} playerName="Luka Dončić" />)
    expect(screen.getByText(/Recent Games/)).toBeTruthy()
    expect(screen.queryByTestId("recent-games-empty")).toBeNull()
    expect(screen.queryByTestId("recent-games-table")).toBeNull()
  })

  it("no linked feed renders nothing — an absence is not a claim", () => {
    const { container } = render(<PlayerRecentGames result={result({ linked: 0, espn_ids: [], games: [] })} ok playerName="X" />)
    expect(container.innerHTML).toBe("")
    const n = render(<PlayerRecentGames result={null} ok playerName="X" />)
    expect(n.container.innerHTML).toBe("")
  })

  it("two athletes behind one key renders nothing — their games are never merged", () => {
    const { container } = render(<PlayerRecentGames result={result({ linked: 2, espn_ids: ["1", "2"] })} ok playerName="Josh Allen" />)
    expect(container.innerHTML).toBe("")
  })

  it("linked with no games says so", () => {
    render(<PlayerRecentGames result={result({ games: [] })} ok playerName="X" />)
    expect(screen.getByTestId("recent-games-empty").textContent).toMatch(/No games from the feed yet/)
  })
})

describe("PlayerRecentGames — rows", () => {
  it("one row per game: line, FP vs the season average, market-cap move, did-not-play kept distinct", () => {
    render(<PlayerRecentGames result={result()} ok playerName="Luka Dončić" />)
    const rows = screen.getAllByTestId("recent-games-row")
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toMatch(/vs POR/)
    expect(rows[0].textContent).toMatch(/53 pts, 5 reb, 5 ast, 1 stl, 38 min/)
    expect(rows[0].textContent).toMatch(/69\.8/)
    expect(rows[0].textContent).toMatch(/-1\.8 vs avg/)
    expect(rows[0].textContent).toMatch(/\+4\.9%/)
    expect(rows[1].textContent).toMatch(/@ LAL/)
    expect(rows[1].textContent).toMatch(/Did not play/)
    // a missing market-cap side is a dash, never a 0 % move
    expect(rows[1].textContent).not.toMatch(/0\.0%/)
  })

  it("says what the numbers cannot: one game is not evidence; and no confidence tier anywhere", () => {
    const { container } = render(<PlayerRecentGames result={result()} ok playerName="Luka Dončić" />)
    expect(screen.getByTestId("recent-games-footnote").textContent).toMatch(/single game is not evidence/)
    expect(container.textContent ?? "").not.toMatch(/\b(HIGH|MEDIUM|LOW)\b|confidence/i)
  })

  it("names supply only when it is a real share of the move", () => {
    // +4 of 220,792 beside +4.9 % is price, not supply
    expect(gameMoveCell(LUKA).supply).toBeNull()
    render(<PlayerRecentGames result={result()} ok playerName="Luka Dončić" />)
    expect(screen.queryByTestId("recent-games-supply")).toBeNull()
    // +10 of 100 beside +12 % is supply
    const minted = gameMoveCell({ ...LUKA, mcap_before: 100, mcap_after: 112, held_before: 100, held_after: 110 })
    expect(minted.text).toBe("+12.0%")
    expect(minted.supply).toBe("supply +10")
  })

  it("an MLB game has no fabricated line or FP column", () => {
    const mlb: RecentGame = { ...LUKA, league: "mlb", fantasy_points: null, stats: { batting: { hits: "2" } } }
    render(<PlayerRecentGames result={result({ games: [mlb], season_avg_fp: null })} ok playerName="X" />)
    expect(screen.getByTestId("recent-games-row").textContent).toMatch(/—/)
    expect(screen.queryByText("FP")).toBeNull()
  })
})

describe("PlayerRecentGames — wired into the player page", () => {
  const SRC = readFileSync("app/(collections)/[collection]/player/[slug]/page.tsx", "utf8")
  it("reads by the PERSON for Top Shot / All Day / Candy and streams in its own Suspense", () => {
    expect(SRC).toMatch(/"get_player_recent_games"/)
    expect(SRC).toMatch(/p_player_id: RECENT_GAMES_PERSON_COLLECTIONS\.has\(collectionSlug\) \? playerId : null/)
    expect(SRC).toMatch(/<Suspense fallback=\{null\}>\s*<RecentGamesSection /)
  })
})
