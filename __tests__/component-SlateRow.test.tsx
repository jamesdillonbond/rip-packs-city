// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import SlateRow from "@/components/fast-break/SlateRow"

afterEach(() => cleanup())

const game = (over: Partial<{ gameId: string; homeTeam: string; awayTeam: string; tipoffAt: string | null; status: string }> = {}) => ({
  gameId: "g1",
  homeTeam: "LAL",
  awayTeam: "BOS",
  tipoffAt: "2026-07-26T23:30:00Z",
  status: "scheduled",
  ...over,
})

describe("SlateRow", () => {
  it("renders the empty state when there are no games", () => {
    const { container } = render(<SlateRow games={[]} gameDate="2026-07-26" />)
    expect(container.textContent).toContain("No games tonight")
    expect(container.textContent).toContain("2026-07-26")
    expect(container.textContent).toContain("slate empty")
  })

  it("renders one card per game with the matchup and an aria-labelled row", () => {
    const { container, getByLabelText } = render(
      <SlateRow games={[game({ gameId: "a" }), game({ gameId: "b", homeTeam: "MIN", awayTeam: "DEN" })]} gameDate="2026-07-26" />,
    )
    getByLabelText("Tonight's NBA slate")
    expect(container.textContent).toContain("BOS")
    expect(container.textContent).toContain("LAL")
    expect(container.textContent).toContain("DEN")
    expect(container.textContent).toContain("MIN")
  })

  it("renders a time label (a tip-off resolves to a formatted time, not TBD)", () => {
    const { container } = render(<SlateRow games={[game()]} gameDate="2026-07-26" />)
    // After mount it flips to local time; either way it should be a real clock time.
    expect(container.textContent).toMatch(/\d{1,2}:\d{2}/)
    expect(container.textContent).not.toContain("TBD")
  })

  it("shows TBD when tip-off is null or unparseable", () => {
    const { container } = render(
      <SlateRow games={[game({ tipoffAt: null }), game({ gameId: "x", tipoffAt: "not-a-date" })]} gameDate="2026-07-26" />,
    )
    expect(container.textContent).toContain("TBD")
  })

  it("renders the Live status badge", () => {
    const { container } = render(<SlateRow games={[game({ status: "live" })]} gameDate="2026-07-26" />)
    expect(container.textContent).toContain("Live")
  })

  it("renders the Final status badge", () => {
    const { container } = render(<SlateRow games={[game({ status: "final" })]} gameDate="2026-07-26" />)
    expect(container.textContent).toContain("Final")
  })

  it("renders the Scheduled badge for any other status", () => {
    const { container } = render(<SlateRow games={[game({ status: "postponed" })]} gameDate="2026-07-26" />)
    expect(container.textContent).toContain("Scheduled")
  })
})
