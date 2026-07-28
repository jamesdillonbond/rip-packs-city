// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, waitFor, fireEvent } from "@testing-library/react"

// Children stubbed to markers so the test drives LoansDashboard's OWN code: the
// 7-endpoint Promise.all, the loading/soft-fail state machine, the window-change
// refetch, and the pinned-collection scoping. Its numeric logic is already tested
// in lib/analytics-loans-dashboard-compute.
vi.mock("@/components/analytics/KpiCard", () => ({ default: () => null }))
vi.mock("@/components/analytics/HealthBar", () => ({ default: () => null }))
vi.mock("@/components/analytics/VolumeChart", () => ({ default: () => null }))
vi.mock("@/components/analytics/NewWalletsChart", () => ({ default: () => null }))
vi.mock("@/components/analytics/CohortRetention", () => ({ default: () => null }))
vi.mock("@/components/analytics/LeaderboardTable", () => ({ default: () => null }))
vi.mock("@/components/analytics/LenderPerformanceTable", () => ({ default: () => null }))
vi.mock("@/components/analytics/PositionTransfersCard", () => ({ default: () => null }))
vi.mock("@/components/analytics/ExploreSection", () => ({ default: () => null }))
vi.mock("@/components/analytics/FilterBar", () => ({
  default: ({ onWindowChange }: { onWindowChange: (w: string) => void }) => (
    <button data-testid="win-30" onClick={() => onWindowChange("l30")}>30d</button>
  ),
}))

import LoansDashboard from "@/components/analytics/LoansDashboard"

function routeFetch() {
  return vi.fn(async (url: string) => {
    const u = String(url)
    let body: any = {}
    if (u.includes("/loans/summary")) body = { prior_period: null }
    else if (u.includes("/loans/limbo-summary")) body = {}
    else if (u.includes("/loans/timeseries")) body = { rows: [], bucket: "day" }
    else if (u.includes("/loans/new-wallets")) body = { rows: [] }
    else if (u.includes("/loans/cohorts")) body = { rows: [] }
    else if (u.includes("/loans/leaderboard")) body = { role: "lender", rows: [] }
    return { ok: true, json: async () => body } as any
  })
}

let fetchMock: ReturnType<typeof routeFetch>
beforeEach(() => {
  fetchMock = routeFetch()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("LoansDashboard", () => {
  it("fires all seven analytics endpoints on mount", async () => {
    render(<LoansDashboard />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7))
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    for (const frag of ["/loans/summary", "/loans/limbo-summary", "/loans/timeseries", "/loans/new-wallets", "/loans/cohorts", "role=lender", "role=borrower"]) {
      expect(urls.some((u) => u.includes(frag))).toBe(true)
    }
  })

  it("soft-fails on a rejected fetch without crashing", async () => {
    fetchMock.mockRejectedValue(new Error("network"))
    expect(() => render(<LoansDashboard />)).not.toThrow()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })

  it("re-fetches all endpoints when the window changes", async () => {
    render(<LoansDashboard />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7))
    fireEvent.click(screen.getByTestId("win-30"))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(14))
  })

  it("scopes every fetch to a pinned collection", async () => {
    render(<LoansDashboard collection="topshot" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7))
    expect(fetchMock.mock.calls.every((c) => String(c[0]).includes("topshot"))).toBe(true)
  })
})
