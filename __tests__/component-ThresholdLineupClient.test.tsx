// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor, screen } from "@testing-library/react"

// Regular-season Fast Break view. useWarmCache is mocked so each state of
// /api/fast-break/tonight can be rendered directly.
let warm: { data: unknown; loading: boolean; error: unknown } = { data: null, loading: false, error: null }
const refresh = vi.fn()
vi.mock("@/lib/warmup/WarmupContext", () => ({
  useWarmCache: (key: string) => ({ ...warm, dataKey: key, refresh }),
}))

import ThresholdLineupClient from "@/components/fast-break/ThresholdLineupClient"

const props = { walletAddr: "0xabcdef0123456789", runId: "run1", gameDate: "2026-11-27" }

function p(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    nbaPlayerId: id, fullName: name, teamAbbr: "POR", proj: { fg3m: 3.4, fg3a: 8.1 },
    injuryStatus: "ACTIVE", remainingUses: 2, totalUses: 2, highestTier: "RARE",
    bestMomentId: `m-${id}`, bestSerial: 42, gameId: "g1", opponentTeamAbbr: "LAL", ...extra,
  }
}

const okData = {
  runName: "Classic Run — Nov 16–29",
  gameDate: "2026-11-27",
  dataStatus: "ok",
  objective: "Combine for 18 3-Pointers Made + 40 3-Pointers Attempted",
  targets: { fg3m: 18, fg3a: 40 },
  lineupSize: 5,
  hasCaptain: true,
  eligibleCount: 40,
  onSlateCount: 12,
  lineup: {
    players: [p("a", "Deni Avdija"), p("b", "Shaedon Sharpe", { remainingUses: null, totalUses: null }), p("c", "Player C"), p("d", "Player D"), p("e", "Player E")],
    captainNbaPlayerId: "a",
    bench: p("f", "Bench Guy"),
    winProbability: 0.83,
    targets: [
      { stat: "fg3m", label: "3-Pointers Made", target: 18, projected: 19.4, probability: 0.88 },
      { stat: "fg3a", label: "3-Pointers Attempted", target: 40, projected: 43.1, probability: 0.94 },
    ],
    serialSum: 210,
  },
  slateBest: { winProbability: 0.97, missing: [{ nbaPlayerId: "z", fullName: "Stephen Curry", teamAbbr: "GSW", reason: "not_owned" }] },
}

beforeEach(() => {
  warm = { data: null, loading: false, error: null }
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, idempotent: false }) }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe("ThresholdLineupClient", () => {
  it("shows a loading line, then an outage line that blames us — not the roster — on error", () => {
    const { rerender } = render(<ThresholdLineupClient {...props} />)
    expect(screen.getByText(/Building tonight's lineup/)).toBeTruthy()
    warm = { data: null, loading: false, error: new Error("tonight 500") }
    rerender(<ThresholdLineupClient {...props} />)
    expect(screen.getByText(/problem on our side/)).toBeTruthy()
  })

  it("renders the objective, the odds, both targets, five players with the Captain, and the bench", () => {
    warm = { data: okData, loading: false, error: null }
    render(<ThresholdLineupClient {...props} />)
    expect(screen.getByText("Combine for 18 3-Pointers Made + 40 3-Pointers Attempted")).toBeTruthy()
    expect(screen.getByText("83%")).toBeTruthy()
    expect(screen.getByText("3-Pointers Made")).toBeTruthy()
    expect(screen.getByText("3-Pointers Attempted")).toBeTruthy()
    expect(screen.getByText(/Captain 1.5×/)).toBeTruthy()
    expect(screen.getByText(/Unlimited uses/)).toBeTruthy()
    expect(screen.getByText("Bench Guy")).toBeTruthy()
    expect(screen.getByText(/Stephen Curry/)).toBeTruthy()
    expect(screen.getByText(/not in your collection/)).toBeTruthy()
  })

  it("says the targets are not recorded yet instead of building a lineup without them", () => {
    warm = { data: { ...okData, dataStatus: "targets_unknown", objective: null, lineup: null, slateBest: null }, loading: false, error: null }
    render(<ThresholdLineupClient {...props} />)
    expect(screen.getByText(/haven't been recorded on RPC yet/)).toBeTruthy()
    expect(screen.queryByText("Save this lineup")).toBeNull()
  })

  it("says how many players are short when the roster can't fill five", () => {
    warm = { data: { ...okData, lineup: null, onSlateCount: 3, slateBest: null }, loading: false, error: null }
    render(<ThresholdLineupClient {...props} />)
    expect(screen.getByText(/Only 3 of your players/)).toBeTruthy()
  })

  it("saves the lineup with its Captain and confirms", async () => {
    warm = { data: okData, loading: false, error: null }
    render(<ThresholdLineupClient {...props} />)
    fireEvent.click(screen.getByText("Save this lineup"))
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Lineup saved/))
    const body = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(body.players).toHaveLength(5)
    expect(body.captainNbaPlayerId).toBe("a")
    expect(refresh).toHaveBeenCalled()
  })

  it("surfaces a use-budget refusal from the save route", async () => {
    warm = { data: okData, loading: false, error: null }
    ;(fetch as any).mockResolvedValueOnce({ ok: false, status: 409, json: () => Promise.resolve({ error: "exceeds_use_budget" }) })
    render(<ThresholdLineupClient {...props} />)
    fireEvent.click(screen.getByText("Save this lineup"))
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/exceeds use budget/))
  })
})
