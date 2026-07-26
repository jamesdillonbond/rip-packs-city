// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

// Control every useWarmCache call by key so we can drive RTRClient's three
// sections (Tonight's Pick / Tier Progress / Lock ROI) through loading, empty,
// and loaded states without a live WarmupProvider or network.
const warmByKey: Record<string, { data: unknown; loading: boolean; error: unknown }> = {}
vi.mock("@/lib/warmup/WarmupContext", () => ({
  useWarmCache: (key: string) => ({
    data: warmByKey[key]?.data ?? null,
    loading: warmByKey[key]?.loading ?? false,
    error: warmByKey[key]?.error ?? null,
    refresh: vi.fn(),
  }),
}))

import RTRClient from "@/components/rtr/RTRClient"

const WALLET = "0xabc"
function setWarm(map: Record<string, { data?: unknown; loading?: boolean; error?: unknown }>) {
  for (const k of Object.keys(warmByKey)) delete warmByKey[k]
  for (const [k, v] of Object.entries(map)) {
    warmByKey[k] = { data: v.data ?? null, loading: v.loading ?? false, error: v.error ?? null }
  }
}

const livePick = {
  gameId: "g1",
  homeTeam: "Lakers",
  awayTeam: "Celtics",
  recommendedSide: "home_ml" as const,
  impliedProbability: 0.62,
  rationale: "Home favorite with rest edge.",
  homeML: -160,
  awayML: 135,
  tipoffAt: "2026-07-26T23:30:00Z",
  bookmaker: "DraftKings",
  oddsLastSyncedAt: "2026-07-26T22:00:00Z",
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe("RTRClient", () => {
  it("shows the loading skeleton for Tonight's Pick while picks load", () => {
    setWarm({ "rtr-picks-today": { loading: true } })
    const { container } = render(<RTRClient walletAddr={WALLET} />)
    expect(container.textContent).toContain("Tonight's Pick")
  })

  it("renders the empty 'no odds' state when there is no pick", () => {
    setWarm({ "rtr-picks-today": { data: { picks: [] } } })
    const { container } = render(<RTRClient walletAddr={WALLET} />)
    expect(container.textContent).toContain("No game odds available right now")
  })

  it("surfaces the no_fresh_odds note when present", () => {
    setWarm({ "rtr-picks-today": { data: { picks: [], message: "no_fresh_odds", note: "Season is over." } } })
    const { container } = render(<RTRClient walletAddr={WALLET} />)
    expect(container.textContent).toContain("Season is over.")
  })

  it("renders the live pick card with the recommended side and de-vigged %", () => {
    setWarm({
      "rtr-picks-today": { data: { picks: [livePick] } },
      "rtr-state": { data: { reportedTotalPoints: 100, reportedSpendableBalance: 50, currentTier: "bronze", reportedAt: null, updatedAt: null } },
      [`rtr-lock-roi:${WALLET}`]: {
        data: {
          walletAddr: WALLET,
          rowCount: 1,
          totalAvailable: 1,
          moments: [
            { momentId: "m1", playerName: "LeBron James", setName: "Base", currentFmvUsd: 42, isLocked: false, estimatedPlayoffPoints: 12, pointsPerDollar: 0.28, serialNumber: 7, tier: "COMMON" },
          ],
        },
      },
    })
    const { container } = render(<RTRClient walletAddr={WALLET} />)
    // recommended side is home_ml → Lakers (CSS uppercases; jsdom textContent stays as-is)
    expect(container.textContent).toContain("Lakers ML")
    expect(container.textContent).toContain("vs Celtics")
    expect(container.textContent).toContain("via DraftKings")
    // the lock-roi moment renders
    expect(container.textContent).toContain("LeBron James")
  })
})
