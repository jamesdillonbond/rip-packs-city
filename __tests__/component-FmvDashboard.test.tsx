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

// The empty-state suite above never renders a data row, so the whole
// TopMoversTable / TierPulseSection body (positive vs negative styling, the
// thin-data warning, linkable-vs-plain edition cells, tier-share bars) stayed
// dark — the bulk of this file's branches. These drive the WITH-DATA paths.
function dataFetch() {
  return vi.fn(async (url: string) => {
    const u = String(url)
    let body: any = {}
    if (u.includes("/fmv/health")) {
      body = { collections: {}, as_of: "2026-07-28T00:00:00Z" }
    } else if (u.includes("/fmv/tier-pulse")) {
      body = {
        rows: [
          { collection: "nba_top_shot", tier: "Rare", edition_count: 10, total_fmv_usd: 900, avg_fmv_usd: 90, median_fmv_usd: 80, high_conf_count: 8, low_conf_count: 2 },
          { collection: "nba_top_shot", tier: "Common", edition_count: 40, total_fmv_usd: 100, avg_fmv_usd: 2.5, median_fmv_usd: 2, high_conf_count: 1, low_conf_count: 39 },
        ],
      }
    } else if (u.includes("/fmv/top-movers")) {
      body = {
        rows: [
          // positive, linkable (UUID edition_id), thin data (LOW confidence + 0 sales)
          { rank: 1, collection: "nba_top_shot", edition_id: "11111111-1111-4111-8111-111111111111", player_name: "Dame Lillard", set_name: "Base Set", current_fmv_usd: 120, prior_fmv_usd: 100, change_usd: 20, change_pct: 20, current_confidence: "LOW", prior_confidence: "LOW", sales_count_7d: 0 },
          // negative, NON-linkable (int-pair edition_id), not thin (HIGH + sales)
          { rank: 2, collection: "nfl_all_day", edition_id: "3:45", player_name: "Josh Allen", set_name: "Series 1", current_fmv_usd: 80, prior_fmv_usd: 100, change_usd: -20, change_pct: -20, current_confidence: "HIGH", prior_confidence: "HIGH", sales_count_7d: 6 },
        ],
      }
    }
    return { ok: true, json: async () => body } as any
  })
}

describe("FmvDashboard — with data", () => {
  beforeEach(() => {
    fetchMock = dataFetch()
    vi.stubGlobal("fetch", fetchMock)
  })

  it("renders mover rows for both a gainer and a loser (no empty state)", async () => {
    render(<FmvDashboard />)
    await waitFor(() => expect(screen.getByText("Dame Lillard")).toBeTruthy())
    expect(screen.getByText("Josh Allen")).toBeTruthy()
    // With rows present the empty state must NOT render.
    expect(screen.queryByText(/No significant movers/i)).toBeNull()
  })

  it("links the linkable (UUID) edition and leaves the int-pair edition unlinked", async () => {
    render(<FmvDashboard />)
    const dame = await screen.findByText("Dame Lillard")
    // the UUID mover is wrapped in an <a href="/edition/<uuid>">
    expect(dame.closest("a")?.getAttribute("href")).toBe(
      "/edition/11111111-1111-4111-8111-111111111111",
    )
    // the int-pair mover has no edition link
    expect(screen.getByText("Josh Allen").closest("a")).toBeNull()
  })

  it("flags the thin-data mover with its warning title", async () => {
    render(<FmvDashboard />)
    await screen.findByText("Dame Lillard")
    // isThinMover: LOW confidence + 0 sales -> the amber warning is rendered.
    expect(screen.getByTitle(/Thin data/i)).toBeTruthy()
  })

  it("renders the tier-pulse section instead of its empty state", async () => {
    render(<FmvDashboard />)
    await waitFor(() => expect(screen.queryByText(/No tier data available/i)).toBeNull())
    // both tiers surface as labels in the grouped collection block
    expect(screen.getAllByText("Rare").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Common").length).toBeGreaterThan(0)
  })
})
