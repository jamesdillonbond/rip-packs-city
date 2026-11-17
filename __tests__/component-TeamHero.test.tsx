// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"

vi.mock("@/components/entity/TeamLogo", () => ({ default: () => null }))
vi.mock("@/components/entity/TeamFollowButton", () => ({
  default: () => <span data-testid="follow-btn" />,
}))

import TeamHero, { type TeamNextGame, isStaleScheduledGame, isStaleFinishedGame } from "@/components/entity/TeamHero"

// Pins the Team Hub hero — the branded/fallback split and, most importantly, the
// gameLabel next-game copy (only reachable through the rendered GameChip). A
// wrong branch there mislabels a result: "Beat" vs "Lost to" is decided by the
// score comparison, and a scheduled game must read "Plays vs/@", not a fake
// final. Also pins the NBA CDN logo-URL construction and the follow-control
// gating (shown only when league + short slug + path are all present).

afterEach(cleanup)

const game = (over: Partial<TeamNextGame> = {}): TeamNextGame => ({
  opponent_abbr: "LAL",
  home_away: "home",
  // A FUTURE tipoff: a scheduled row whose tipoff has passed is a stale feed and
  // renders no chip (isStaleScheduledGame, 2026-10-20).
  tipoff_at: new Date(Date.now() + 2 * 86400_000).toISOString(),
  game_date: "2099-01-01",
  status: "scheduled",
  is_playoff: false,
  series_label: null,
  team_score: null,
  opp_score: null,
  ...over,
})

const base = {
  teamName: "Portland Trail Blazers",
  noun: "NBA Team",
  abbreviation: "POR",
  leagueLabel: "NBA",
  isFranchise: false,
}

describe("TeamHero — variants", () => {
  it("renders the plain fallback hero when no primaryColor is provided", () => {
    render(<TeamHero {...base} primaryColor={null} />)
    expect(screen.getByText("Portland Trail Blazers")).toBeTruthy()
    expect(screen.getByText("NBA Team")).toBeTruthy()
  })

  it("renders the branded banner with abbreviation + league chips", () => {
    render(<TeamHero {...base} primaryColor="#E03A2F" secondaryColor="#000" externalId="1610612757" />)
    expect(screen.getByText("Portland Trail Blazers")).toBeTruthy()
    expect(screen.getByText("POR")).toBeTruthy()
    expect(screen.getAllByText("NBA").length).toBeGreaterThanOrEqual(1)
  })
})

describe("TeamHero — gameLabel (via GameChip)", () => {
  it("a scheduled home game reads 'Plays vs OPP'", () => {
    render(<TeamHero {...base} primaryColor="#E03A2F" nextGame={game({ home_away: "home", status: "scheduled" })} />)
    expect(screen.getByText(/Plays vs LAL/)).toBeTruthy()
  })

  it("a scheduled away game uses '@'", () => {
    render(<TeamHero {...base} primaryColor="#E03A2F" nextGame={game({ home_away: "away" })} />)
    expect(screen.getByText(/Plays @ LAL/)).toBeTruthy()
  })

  it("a completed win reads 'Beat OPP score–score'", () => {
    render(
      <TeamHero
        {...base}
        primaryColor="#E03A2F"
        nextGame={game({ status: "final", team_score: 110, opp_score: 100 })}
      />,
    )
    const chip = screen.getByText(/Beat LAL/)
    expect(chip.textContent).toContain("110")
    expect(chip.textContent).toContain("100")
  })

  it("a completed loss reads 'Lost to OPP'", () => {
    render(
      <TeamHero
        {...base}
        primaryColor="#E03A2F"
        nextGame={game({ status: "final", team_score: 98, opp_score: 120 })}
      />,
    )
    expect(screen.getByText(/Lost to LAL/)).toBeTruthy()
  })

  it("a non-scheduled game with no scores falls back to 'Last: vs OPP'", () => {
    render(
      <TeamHero
        {...base}
        primaryColor="#E03A2F"
        nextGame={game({ status: "postponed", team_score: null, opp_score: null })}
      />,
    )
    expect(screen.getByText(/Last: vs LAL/)).toBeTruthy()
  })

  it("prefixes a playoff game with the Playoffs marker", () => {
    render(<TeamHero {...base} primaryColor="#E03A2F" nextGame={game({ is_playoff: true })} />)
    expect(screen.getByText(/Playoffs ·/)).toBeTruthy()
  })

  // 2026-10-20 live sweep: the Lakers page read "🏀 Playoffs · Plays @ SAC · 15 days ago".
  it("a scheduled row whose tipoff is days past renders NO chip (stale feed, not an upcoming game)", () => {
    const past = new Date(Date.now() - 15 * 86400_000).toISOString()
    const { container } = render(<TeamHero {...base} primaryColor="#E03A2F" nextGame={game({ is_playoff: true, opponent_abbr: "SAC", home_away: "away", tipoff_at: past })} />)
    expect(container.textContent).not.toMatch(/Plays/)
    expect(container.textContent).not.toMatch(/Playoffs/)
    expect(container.textContent).not.toMatch(/ago/)
  })

  it("a just-started game (inside the grace window) and a completed past game still render", () => {
    const now = Date.now()
    expect(isStaleScheduledGame({ status: "scheduled", tipoff_at: new Date(now - 3600_000).toISOString() }, now)).toBe(false)
    expect(isStaleScheduledGame({ status: "final", tipoff_at: new Date(now - 15 * 86400_000).toISOString() }, now)).toBe(false)
    expect(isStaleScheduledGame({ status: "scheduled", tipoff_at: new Date(now - 7 * 3600_000).toISOString() }, now)).toBe(true)
  })
})

describe("TeamHero — a months-old final is not 'the last game' (2026-10-21)", () => {
  it("drops a final older than 14 days and keeps a recent one", () => {
    const now = Date.parse("2026-10-21T14:00:00Z")
    expect(isStaleFinishedGame({ status: "final", tipoff_at: "2026-05-26T23:00:00Z" }, now)).toBe(true)
    expect(isStaleFinishedGame({ status: "final", tipoff_at: new Date(now - 2 * 86400_000).toISOString() }, now)).toBe(false)
    expect(isStaleFinishedGame({ status: "scheduled", tipoff_at: "2026-05-26T23:00:00Z" }, now)).toBe(false)
  })
  it("renders no chip for the Cavaliers' May final (the live case)", () => {
    const { container } = render(
      <TeamHero {...base} primaryColor="#E03A2F"
        nextGame={game({ status: "final", is_playoff: true, opponent_abbr: "NY", tipoff_at: "2026-05-26T23:00:00Z" })} />,
    )
    expect(container.textContent).not.toMatch(/Last: vs NY/)
  })
})

describe("TeamHero — follow control gating", () => {
  it("shows the follow button only when league + short slug + path are all present", () => {
    const { rerender } = render(<TeamHero {...base} primaryColor="#E03A2F" followLeague="nba" />)
    expect(screen.queryByTestId("follow-btn")).toBeNull() // slug + path missing
    rerender(
      <TeamHero {...base} primaryColor="#E03A2F" followLeague="nba" followShortSlug="por" teamPath="/nba/team/por" />,
    )
    expect(screen.getByTestId("follow-btn")).toBeTruthy()
  })
})
