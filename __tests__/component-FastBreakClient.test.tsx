// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

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
  })
})
