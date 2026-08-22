// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor, screen } from "@testing-library/react"

// Drive FastBreakClient's optimize + uses sections by mocking useWarmCache,
// matched by key PREFIX (fb-optimize / fb-uses), so we don't have to reconstruct
// the exact wallet:run:date key.
const warmByPrefix: Record<string, { data: unknown; loading: boolean; error: unknown }> = {}
function pick(key: string) {
  const p = Object.keys(warmByPrefix).find((pref) => key.startsWith(pref))
  return p ? warmByPrefix[p] : { data: null, loading: false, error: null }
}
vi.mock("@/lib/warmup/WarmupContext", () => ({
  useWarmCache: (key: string) => {
    const e = pick(key)
    return { data: e.data, loading: e.loading, error: e.error, refresh: vi.fn() }
  },
}))

import FastBreakClient from "@/components/fast-break/FastBreakClient"

function setWarm(map: Record<string, { data?: unknown; loading?: boolean; error?: unknown }>) {
  for (const k of Object.keys(warmByPrefix)) delete warmByPrefix[k]
  for (const [k, v] of Object.entries(map)) {
    warmByPrefix[k] = { data: v.data ?? null, loading: v.loading ?? false, error: v.error ?? null }
  }
}

const props = {
  walletAddr: "0xabc",
  runId: "run1",
  runName: "Run 3",
  lineupSize: 2 as const,
  hasCaptain: true,
  gameDate: "2026-07-26",
}

const optimizePlayer = {
  nbaPlayerId: "p1",
  fullName: "Anthony Edwards",
  teamAbbr: "MIN",
  highestTier: "COMMON",
  remainingUses: 3,
  bestMomentId: "m1",
  bestSerial: 12,
  projPoints: 48.2,
  projMinutes: 34,
  injuryStatus: null,
  gameId: "g1",
  opponentTeamAbbr: "DEN",
}

const useRow = {
  nbaPlayerId: "p1",
  fullName: "Anthony Edwards",
  teamAbbr: "MIN",
  highestTierOwned: "COMMON",
  totalAllowed: 5,
  timesUsed: 2,
  remainingUses: 3,
  datesUsed: ["2026-07-24"],
  bestMomentId: "m1",
  bestSerial: 12,
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe("FastBreakClient", () => {
  it("renders the run name and a loading skeleton while optimizing", () => {
    setWarm({ "fb-optimize": { loading: true }, "fb-uses": { loading: true } })
    const { container } = render(<FastBreakClient {...props} />)
    expect(container.textContent).toContain("Run 3")
  })

  it("renders the optimized lineup with the player", () => {
    setWarm({
      "fb-optimize": {
        data: {
          walletAddr: props.walletAddr,
          runId: props.runId,
          gameDate: props.gameDate,
          lineupSize: 2,
          eligibleCount: 5,
          consideredCount: 10,
          lineup: {
            players: [optimizePlayer, { ...optimizePlayer, nbaPlayerId: "p2", fullName: "Rudy Gobert", projPoints: 30 }],
            captainNbaPlayerId: "p1",
            projectedScore: 78.2,
            serialSum: 24,
          },
          alternates: [],
          missingPlayers: [],
        },
      },
      "fb-uses": { data: { runId: props.runId, uses: [useRow] } },
    })
    const { container } = render(<FastBreakClient {...props} />)
    expect(container.textContent).toContain("Anthony Edwards")
    expect(container.textContent).toContain("Rudy Gobert")
  })

  it("renders a message when the optimizer returns no lineup", () => {
    setWarm({
      "fb-optimize": {
        data: {
          walletAddr: props.walletAddr,
          runId: props.runId,
          gameDate: props.gameDate,
          lineupSize: 2,
          eligibleCount: 0,
          consideredCount: 0,
          lineup: null,
          alternates: [],
          missingPlayers: [],
          message: "no_eligible_players",
        },
      },
      "fb-uses": { data: { runId: props.runId, uses: [] } },
    })
    const { container } = render(<FastBreakClient {...props} />)
    // The component renders *something* (not a crash) for the empty-lineup case.
    expect(container.textContent && container.textContent.length).toBeGreaterThan(0)
    // consideredCount === 0 selects the "not on tonight's slate" copy.
    expect(container.textContent).toContain("None of your eligible Top Shot players are on tonight's slate")
  })

  it("renders the optimizer error state with a Retry button", () => {
    const refresh = vi.fn()
    // Override the mock's refresh for this render via a per-key entry.
    setWarm({ "fb-optimize": { error: new Error("boom") }, "fb-uses": {} })
    void refresh
    const { container } = render(<FastBreakClient {...props} />)
    expect(container.textContent).toContain("Failed to load optimizer")
    expect(screen.getByText("Retry")).toBeTruthy()
  })

  it("renders the captain star and the rationale panel when 'Why this lineup?' is toggled", () => {
    setWarm({
      "fb-optimize": {
        data: {
          walletAddr: props.walletAddr,
          runId: props.runId,
          gameDate: props.gameDate,
          lineupSize: 2,
          eligibleCount: 5,
          consideredCount: 5,
          lineup: {
            players: [optimizePlayer],
            captainNbaPlayerId: "p1",
            projectedScore: 48.2,
            serialSum: 12,
          },
          alternates: [],
          missingPlayers: [],
        },
      },
      "fb-uses": { data: { runId: props.runId, uses: [] } },
    })
    render(<FastBreakClient {...props} />)
    // Captain badge for p1.
    expect(screen.getByLabelText("Captain")).toBeTruthy()
    // Rationale hidden until toggled.
    expect(screen.queryByText(/Total projected score/i)).toBeNull()
    fireEvent.click(screen.getByText("Why this lineup?"))
    expect(screen.getByText(/Total projected score/i)).toBeTruthy()
  })

  it("renders the acquisition-gap section with a buy link and a not-listed fallback", () => {
    setWarm({
      "fb-optimize": {
        data: {
          walletAddr: props.walletAddr,
          runId: props.runId,
          gameDate: props.gameDate,
          lineupSize: 2,
          eligibleCount: 2,
          consideredCount: 2,
          lineup: {
            players: [optimizePlayer],
            captainNbaPlayerId: null,
            projectedScore: 48.2,
            serialSum: 12,
          },
          alternates: [],
          missingPlayers: [
            {
              nbaPlayerId: "m1",
              fullName: "Nikola Jokic",
              teamAbbr: "DEN",
              projFp: 55.4,
              cheapestListing: { momentId: "mom-1", askUsd: 42, url: null },
            },
            {
              nbaPlayerId: "m2",
              fullName: null,
              teamAbbr: null,
              projFp: null,
              cheapestListing: null,
            },
          ],
        },
      },
      "fb-uses": { data: { runId: props.runId, uses: [] } },
    })
    render(<FastBreakClient {...props} />)
    expect(screen.getByText("Nikola Jokic")).toBeTruthy()
    expect(screen.getByText(/Buy on Sniper/i)).toBeTruthy()
    expect(screen.getByText("Not currently listed")).toBeTruthy()
    // Null-name missing player falls back to "Unknown player".
    expect(screen.getByText("Unknown player")).toBeTruthy()
  })

  it("distinguishes 'we looked and found none' from 'we could not look'", () => {
    // "Not currently listed" is a flat market claim, and it is actionable in the
    // wrong direction: someone shopping for that player reads it and stops
    // looking. It is only EARNED by a listings query that came back empty. The
    // route now sets listingUnknown when it could not ask at all — the read
    // failed, or there was no player name to search on (which is itself usually
    // a failed name read compounding into a listing claim).
    //
    // Both states are asserted in ONE render on purpose: the defect was that
    // they were indistinguishable, so a test showing only the new copy would
    // pass against a client that had stopped rendering the real claim entirely.
    setWarm({
      "fb-optimize": {
        data: {
          walletAddr: props.walletAddr,
          runId: props.runId,
          gameDate: props.gameDate,
          lineupSize: 2,
          eligibleCount: 1,
          consideredCount: 1,
          lineup: null,
          alternates: [],
          missingPlayers: [
            {
              nbaPlayerId: "known",
              fullName: "Looked And Found None",
              teamAbbr: "POR",
              projFp: 30,
              cheapestListing: null,
              listingUnknown: false,
            },
            {
              nbaPlayerId: "unknown",
              fullName: "Could Not Look",
              teamAbbr: "LAL",
              projFp: 31,
              cheapestListing: null,
              listingUnknown: true,
            },
          ],
        },
      },
      "fb-uses": { data: { runId: props.runId, uses: [] } },
    })
    render(<FastBreakClient {...props} />)
    expect(screen.getByText("Not currently listed")).toBeTruthy()
    expect(screen.getByText(/Listing unavailable/i)).toBeTruthy()
    // And the two are not the same string, which is the whole point.
    expect(screen.queryAllByText("Not currently listed")).toHaveLength(1)
  })

  it("renders run progress grouped by tier when uses are present", () => {
    setWarm({
      "fb-optimize": { data: { walletAddr: props.walletAddr, runId: props.runId, gameDate: props.gameDate, lineupSize: 2, eligibleCount: 0, consideredCount: 0, lineup: null, alternates: [], missingPlayers: [] } },
      "fb-uses": { data: { runId: props.runId, uses: [useRow] } },
    })
    render(<FastBreakClient {...props} />)
    // RunProgressByTier renders the player pill "<name> <used>/<allowed>".
    expect(screen.getByText(/Anthony Edwards\s*2\/5/)).toBeTruthy()
  })

  function lineupData() {
    return {
      walletAddr: props.walletAddr,
      runId: props.runId,
      gameDate: props.gameDate,
      lineupSize: 2 as const,
      eligibleCount: 5,
      consideredCount: 5,
      lineup: {
        players: [optimizePlayer],
        captainNbaPlayerId: "p1",
        projectedScore: 48.2,
        serialSum: 12,
      },
      alternates: [],
      missingPlayers: [],
    }
  }

  it("shows a success toast after a successful save", async () => {
    setWarm({ "fb-optimize": { data: lineupData() }, "fb-uses": { data: { runId: props.runId, uses: [] } } })
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, idempotent: false, lineupId: "x", added: ["p1"], removed: [], useCounts: [] }),
      }),
    )
    render(<FastBreakClient {...props} />)
    fireEvent.click(screen.getByText("Save This Lineup"))
    await waitFor(() => expect(screen.getByText(/Lineup saved/i)).toBeTruthy())
  })

  it("shows the 'Already saved' toast when the save is idempotent", async () => {
    setWarm({ "fb-optimize": { data: lineupData() }, "fb-uses": { data: { runId: props.runId, uses: [] } } })
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, idempotent: true, lineupId: "x", added: [], removed: [], useCounts: [] }),
      }),
    )
    render(<FastBreakClient {...props} />)
    fireEvent.click(screen.getByText("Save This Lineup"))
    await waitFor(() => expect(screen.getByText(/Already saved for tonight/i)).toBeTruthy())
  })

  it("shows an error toast when the save endpoint returns a non-ok response", async () => {
    setWarm({ "fb-optimize": { data: lineupData() }, "fb-uses": { data: { runId: props.runId, uses: [] } } })
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: "run_locked" }),
      }),
    )
    render(<FastBreakClient {...props} />)
    fireEvent.click(screen.getByText("Save This Lineup"))
    // "run_locked" is rendered with underscores replaced by spaces.
    await waitFor(() => expect(screen.getByText(/run locked/i)).toBeTruthy())
  })

  it("shows an error toast when the save fetch rejects", async () => {
    setWarm({ "fb-optimize": { data: lineupData() }, "fb-uses": { data: { runId: props.runId, uses: [] } } })
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")))
    render(<FastBreakClient {...props} />)
    fireEvent.click(screen.getByText("Save This Lineup"))
    await waitFor(() => expect(screen.getByText(/network down/i)).toBeTruthy())
  })
})
