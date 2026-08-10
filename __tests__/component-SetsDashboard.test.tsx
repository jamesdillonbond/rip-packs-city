// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, waitFor, fireEvent } from "@testing-library/react"

// recharts renders nothing meaningful in jsdom (ResponsiveContainer measures 0×0);
// stub the pieces to plain markers so the SeriesOverview chart branch + the table
// below it render on populated data.
vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    ResponsiveContainer: Pass,
    BarChart: Pass,
    Bar: () => null,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Legend: () => null,
  }
})

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

  it("renders the catalog summary card and directory rows on populated data", async () => {
    const populated = vi.fn(async (url: string) => {
      const u = String(url)
      let body: any = { rows: [] }
      if (u.includes("/sets/summary")) {
        body = {
          as_of: "2026-08-01T00:00:00Z",
          collections: {
            topshot: {
              set_count: 42,
              edition_count: 1234,
              tier_breakdown: { COMMON: 800, RARE: 300, LEGENDARY: 100, ULTIMATE: 34 },
            },
          },
        }
      } else if (u.includes("/sets/series")) {
        body = {
          rows: [
            {
              collection: "topshot",
              series: 0,
              series_label: "Series 1",
              set_count: 5,
              edition_count: 200,
              edition_count_with_fmv: 180,
              median_edition_fmv: 12.5,
              total_series_fmv_robust: 5000,
            },
          ],
        }
      } else if (u.includes("/sets/directory")) {
        body = {
          sort: "value_desc",
          min_coverage: 0,
          limit: 50,
          rows: [
            {
              collection: "topshot",
              set_id: "set-1",
              set_external_id: "EXT-1",
              set_name: "Base Set",
              series: 0,
              edition_count: 50,
              edition_count_with_fmv: 40,
              coverage_pct: 80,
              median_fmv_usd: 10,
              total_fmv_usd: 900,
              total_fmv_robust_usd: 800,
              avg_fmv_usd: 18,
              max_edition_fmv_usd: 500,
              outlier_flag: true,
              earliest_minted_at: null,
            },
          ],
        }
      }
      return { ok: true, json: async () => body } as any
    })
    vi.stubGlobal("fetch", populated)
    render(<SetsDashboard />)
    // CollectionSummaryCard (summaryCollections has a matching key) + directory row.
    await waitFor(() => expect(screen.getByText("Base Set")).toBeTruthy())
    expect(screen.getByText("EXT-1")).toBeTruthy()
    // Series overview table renders past the empty-state guard.
    expect(screen.getByText(/Total robust FMV/i)).toBeTruthy()
  })

  it("refetches all three endpoints when a collection chip is toggled", async () => {
    render(<SetsDashboard />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    fireEvent.click(screen.getByRole("button", { name: "Top Shot" }))
    // collectionsQs changes → summary + series + directory each refire.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6))
    const withCollections = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("collections=topshot"))
    expect(withCollections.length).toBe(3)
  })

  it("refetches the directory when the sort is changed", async () => {
    render(<SetsDashboard />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    const dirCallsBefore = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/sets/directory")).length
    const select = screen.getByDisplayValue("Value")
    fireEvent.change(select, { target: { value: "name_asc" } })
    await waitFor(() => {
      const after = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/sets/directory")).length
      expect(after).toBe(dirCallsBefore + 1)
    })
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("sort=name_asc"))).toBe(true)
  })
})
