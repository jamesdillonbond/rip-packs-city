// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, waitFor } from "@testing-library/react"
import SetsDashboard from "@/components/analytics/SetsDashboard"

// SetsDashboard is fully inline (no child imports). Three independent fetch
// useEffects (summary / series / directory), each with its own loading + catch
// leg. A render test covers that orchestration and the inline empty states; the
// directory/series shaping already lives (tested) in
// lib/analytics-sets-dashboard-compute. Generous empty shapes ({rows:[]}) avoid
// the "map over {}" throw the sibling ListingsDashboard comment warns about.
function routeFetch() {
  return vi.fn(async (url: string) => {
    const u = String(url)
    const body: any = { rows: [], sets: [], series: [], collections: {} }
    void u
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

describe("SetsDashboard", () => {
  it("fires the summary, series, and directory endpoints on mount", async () => {
    render(<SetsDashboard />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.includes("/sets/summary"))).toBe(true)
    expect(urls.some((u) => u.includes("/sets/series"))).toBe(true)
    expect(urls.some((u) => u.includes("/sets/directory"))).toBe(true)
  })

  it("renders the inline series empty-state when there is no series data", async () => {
    render(<SetsDashboard />)
    await waitFor(() => expect(screen.getByText(/No series data available/i)).toBeTruthy())
  })

  it("soft-fails on a rejected fetch without crashing", async () => {
    fetchMock.mockRejectedValue(new Error("network"))
    expect(() => render(<SetsDashboard />)).not.toThrow()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })
})
