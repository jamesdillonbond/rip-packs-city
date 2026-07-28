// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, waitFor } from "@testing-library/react"
import FmvDashboard from "@/components/analytics/FmvDashboard"

// FmvDashboard has all its sub-components inline (no child imports to stub) and
// three independent fetch useEffects (health / tier-pulse / top-movers), each
// with its own loading + soft-fail(catch) leg. A render test covers that fetch
// orchestration and the inline tables' empty states — the reachable-without-data
// bulk of this 740-line file — while its numeric logic already lives (tested) in
// lib/analytics-fmv-dashboard-compute.

function routeFetch() {
  return vi.fn(async (url: string) => {
    const u = String(url)
    let body: any = {}
    if (u.includes("/fmv/health")) body = { collections: {}, as_of: "2026-07-28T00:00:00Z" }
    else if (u.includes("/fmv/tier-pulse")) body = { rows: [] }
    else if (u.includes("/fmv/top-movers")) body = { rows: [] }
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

describe("FmvDashboard", () => {
  it("fires the health, tier-pulse, and top-movers endpoints on mount", async () => {
    render(<FmvDashboard />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.includes("/fmv/health"))).toBe(true)
    expect(urls.some((u) => u.includes("/fmv/tier-pulse"))).toBe(true)
    expect(urls.some((u) => u.includes("/fmv/top-movers"))).toBe(true)
  })

  it("top-movers carries the direction/window/min_fmv/limit query params", async () => {
    render(<FmvDashboard />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    const movers = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/fmv/top-movers"))!
    expect(movers).toContain("direction=gainers")
    expect(movers).toContain("window_days=7")
    expect(movers).toContain("min_fmv=5")
    expect(movers).toContain("limit=25")
  })

  it("renders the inline empty states when every response is empty", async () => {
    render(<FmvDashboard />)
    await waitFor(() => expect(screen.getByText(/No significant movers/i)).toBeTruthy())
    expect(screen.getByText(/No tier data available/i)).toBeTruthy()
  })

  it("soft-fails on a rejected fetch without crashing", async () => {
    fetchMock.mockRejectedValue(new Error("network"))
    render(<FmvDashboard />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // The empty states still render (catch swallows, finally clears loading).
    await waitFor(() => expect(screen.getByText(/No significant movers/i)).toBeTruthy())
  })
})
