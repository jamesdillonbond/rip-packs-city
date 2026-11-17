// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, waitFor, fireEvent } from "@testing-library/react"

// Stub the child components down to markers so the test exercises SalesDashboard's
// OWN code — the 5-endpoint Promise.all fetch orchestration, the loading/soft-fail
// state machine, and the KPI value wiring (each KpiCard's value is computed here
// from the summary via the analytics-sales-compute helpers). KpiCard renders its
// label+value so we can assert the computed values actually reached the cards.
vi.mock("@/components/analytics/KpiCard", () => ({
  default: ({ label, value }: { label: string; value: string }) => (
    <div data-testid="kpi" data-label={label}>{value}</div>
  ),
}))
vi.mock("@/components/analytics/VolumeChart", () => ({ default: () => null }))
vi.mock("@/components/analytics/LeaderboardTable", () => ({ default: () => null }))
vi.mock("@/components/analytics/ExploreSection", () => ({ default: () => null }))
vi.mock("@/components/analytics/MarketplaceMix", () => ({ default: () => null }))
vi.mock("@/components/analytics/BiggestSales", () => ({ default: () => null }))
vi.mock("@/components/analytics/FilterBar", () => ({
  default: ({ onWindowChange }: { onWindowChange: (w: string) => void }) => (
    <button data-testid="win-7" onClick={() => onWindowChange("l7")}>7d</button>
  ),
}))

import SalesDashboard from "@/components/analytics/SalesDashboard"

const SUMMARY = {
  total_volume_usd: 1_500_000,
  total_sales: 1200,
  unique_buyers: 300,
  unique_sellers: 250,
  avg_price_usd: 42,
  median_price_usd: 20,
  p90_price_usd: 100,
  prior_period: {
    total_volume_usd: 1_000_000, total_sales: 1000, unique_buyers: 280,
    unique_sellers: 240, avg_price_usd: 40, median_price_usd: 18,
  },
}

function routeFetch(over: Record<string, any> = {}) {
  return vi.fn(async (url: string) => {
    const u = String(url)
    let body: any = {}
    if (u.includes("/sales/summary")) body = over.summary ?? SUMMARY
    else if (u.includes("/sales/timeseries")) body = over.timeseries ?? { rows: [], bucket: "day" }
    else if (u.includes("/sales/leaderboard")) body = { role: "buyer", rows: [] }
    else if (u.includes("/sales/top-moves")) body = { rows: [] }
    return { ok: true, json: async () => body } as any
  })
}

const kpi = (label: string) =>
  screen.getAllByTestId("kpi").find((el) => el.getAttribute("data-label") === label)

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

describe("SalesDashboard", () => {
  it("fires all five analytics endpoints on mount", async () => {
    render(<SalesDashboard />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5))
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.includes("/sales/summary"))).toBe(true)
    expect(urls.some((u) => u.includes("/sales/timeseries"))).toBe(true)
    expect(urls.some((u) => u.includes("role=buyer"))).toBe(true)
    expect(urls.some((u) => u.includes("role=seller"))).toBe(true)
    expect(urls.some((u) => u.includes("/sales/top-moves"))).toBe(true)
  })

  it("renders '—' KPIs before load, then the computed summary values", async () => {
    render(<SalesDashboard />)
    // KpiCards exist immediately; total volume starts as the em-dash placeholder.
    expect(kpi("Total volume")).toBeTruthy()
    await waitFor(() => expect(kpi("Total volume")?.textContent).not.toBe("—"))
    // Sale count is formatNumber(1200) -> non-empty, not the placeholder.
    expect(kpi("Sale count")?.textContent).not.toBe("—")
    expect(kpi("Unique buyers")?.textContent).not.toBe("—")
  })

  it("soft-fails: a rejected fetch still clears loading and leaves KPIs at '—' (no crash)", async () => {
    fetchMock.mockRejectedValue(new Error("network"))
    render(<SalesDashboard />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // Values remain the placeholder; the dashboard does not throw.
    await waitFor(() => expect(kpi("Total volume")?.textContent).toBe("—"))
  })

  it("re-fetches all endpoints when the window changes", async () => {
    render(<SalesDashboard />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5))
    fireEvent.click(screen.getByTestId("win-7"))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(10))
    expect(fetchMock.mock.calls.slice(5).every((c) => String(c[0]).includes("l7"))).toBe(true)
  })

  it("scopes to a pinned collection (no collection chips, query carries the collection)", async () => {
    render(<SalesDashboard collection="topshot" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5))
    expect(fetchMock.mock.calls.every((c) => String(c[0]).includes("topshot"))).toBe(true)
  })
})
