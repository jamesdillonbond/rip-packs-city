// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, waitFor } from "@testing-library/react"

// Honest-degradation wiring for the six single-view public /insights boards.
//
// WHY. Each of these pages used to swallow a failed backing read with
// `if (error) return []`, so a statement timeout rendered as an EMPTY board at
// HTTP 200 — byte-identical to "nothing matched". lib/insights/board-status.ts
// exists to fix exactly that, but until now only candy-mlb + panini-squeeze
// consumed it. These tests pin the contract on the six newly-wired boards:
//
//   1. a FAILED server fetch renders the notice (the blank is attributed), and
//   2. a HEALTHY board renders NO notice — including a board that legitimately
//      returned zero rows, which must stay an honest "nothing matched" and must
//      never be dressed up as a failure.
//
// (2) is the load-bearing half: it is what keeps a good page byte-identical to
// its pre-change output, so this wiring can never invent a failure.

import SqueezeBoardClient from "@/app/insights/squeeze/SqueezeBoardClient"
import TrophiesBoardClient from "@/app/insights/trophies/TrophiesBoardClient"
import OfferSpreadBoardClient from "@/app/insights/offer-spread/OfferSpreadBoardClient"
import PinnacleScarcityBoardClient from "@/app/insights/pinnacle-scarcity/PinnacleScarcityBoardClient"
import AllDayScarcityBoardClient from "@/app/insights/allday-scarcity/AllDayScarcityBoardClient"
import SetSqueezeBoardClient from "@/app/insights/set-squeeze/SetSqueezeBoardClient"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"

const FETCHED = "2026-08-11T00:00:00Z"

beforeEach(() => {
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: false, media: q, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia
  }
  vi.stubGlobal("fetch", vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: async () => ({ rows: [], meta: { fetched_at: FETCHED, total_rows: 0 } }),
    } as Response),
  ))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState({}, "", "/")
})

// Each board is a single backing view, so its page builds the summary exactly
// this way. Building it through the real helpers (rather than hand-rolling a
// DegradedSummary literal) keeps the test honest about what the pages produce.
const FAILED = summarizeDegraded([boardStatus("Squeeze board", false)])

const BOARDS = [
  ["SqueezeBoardClient", SqueezeBoardClient],
  ["TrophiesBoardClient", TrophiesBoardClient],
  ["OfferSpreadBoardClient", OfferSpreadBoardClient],
  ["PinnacleScarcityBoardClient", PinnacleScarcityBoardClient],
  ["AllDayScarcityBoardClient", AllDayScarcityBoardClient],
  ["SetSqueezeBoardClient", SetSqueezeBoardClient],
] as const

describe("public /insights boards — honest degradation", () => {
  it("summarizeDegraded phrases a single-view board in the SINGULAR", () => {
    // A one-board surface otherwise renders "1 of 1 sections" — the plural is
    // driven by `total`, not by the failure count.
    expect(FAILED).not.toBeNull()
    expect(FAILED!.headline).toContain("1 of 1 section could not be loaded")
    expect(FAILED!.headline).not.toContain("1 of 1 sections")
    // The second sentence is the load-bearing half: it tells the reader the
    // blank is a fetch failure, not a measurement of zero.
    expect(FAILED!.headline).toContain("not an empty result")
  })

  for (const [name, Board] of BOARDS) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const B = Board as any

    it(`${name} renders the Partial data notice when the server fetch FAILED`, async () => {
      render(<B initialRows={[]} initialFetchedAt={FETCHED} initialDegraded={FAILED} />)
      await waitFor(() => {
        expect(screen.getByText("Partial data")).toBeTruthy()
      })
      expect(
        screen.getByText(/could not be loaded/i).textContent,
      ).toContain("not an empty result")
    })

    it(`${name} renders NO notice when a healthy fetch returned zero rows`, async () => {
      // The honesty constraint in board-status.ts: a board that SUCCEEDED with
      // no rows is a real answer, not a degradation. `summarizeDegraded` returns
      // null for it, and the page passes that through.
      const healthy = summarizeDegraded([boardStatus("Squeeze board", true)])
      expect(healthy).toBeNull()
      render(<B initialRows={[]} initialFetchedAt={FETCHED} initialDegraded={healthy} />)
      expect(screen.queryByText("Partial data")).toBeNull()
    })

    it(`${name} defaults to NO notice when initialDegraded is omitted`, () => {
      render(<B initialRows={[]} initialFetchedAt={FETCHED} />)
      expect(screen.queryByText("Partial data")).toBeNull()
    })
  }
})
