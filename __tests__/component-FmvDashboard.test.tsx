// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, waitFor, fireEvent } from "@testing-library/react"
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

  it("soft-fails on a rejected fetch without crashing, and drops the filter advice", async () => {
    fetchMock.mockRejectedValue(new Error("network"))
    render(<FmvDashboard />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // Used to assert /No significant movers/ — i.e. it pinned a network failure
    // rendering as "nothing moved, try a longer time range", advice to adjust a
    // filter that was never the problem.
    await waitFor(() => expect(screen.getByText(/Couldn't load top movers/i)).toBeTruthy())
    expect(document.body.textContent).not.toMatch(/try a longer time range/i)
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

// The PipelineHealthPanel body (formatUsd/formatNumber/formatMinutesAgo, the
// High/Med/Low/Ask-only chips) was entirely dark — the empty + with-data suites
// above both answer /fmv/health with `collections: {}`, so healthEntries is
// always empty. This fetch populates two collections' stats.
function healthFetch() {
  return vi.fn(async (url: string) => {
    const u = String(url)
    let body: any = {}
    if (u.includes("/fmv/health")) {
      body = {
        as_of: "2026-07-28T00:00:00Z",
        collections: {
          topshot: {
            editions_total: 12000, high_confidence: 4000, medium_confidence: 3000,
            low_confidence: 4500, ask_only: 500, reliable_total_fmv_usd: 2_500_000,
            reliable_avg_fmv_usd: 210, last_refresh: "2026-07-28T00:00:00Z", minutes_since_refresh: 12,
          },
          allday: {
            editions_total: 6000, high_confidence: 800, medium_confidence: 1200,
            low_confidence: 3500, ask_only: 500, reliable_total_fmv_usd: 400_000,
            reliable_avg_fmv_usd: 66, last_refresh: "2026-07-28T00:00:00Z", minutes_since_refresh: 90,
          },
        },
      }
    } else if (u.includes("/fmv/tier-pulse")) body = { rows: [] }
    else if (u.includes("/fmv/top-movers")) body = { rows: [] }
    return { ok: true, json: async () => body } as any
  })
}

describe("FmvDashboard — pipeline health panels", () => {
  beforeEach(() => {
    fetchMock = healthFetch()
    vi.stubGlobal("fetch", fetchMock)
  })

  it("renders per-collection health cards with confidence chips + totals", async () => {
    render(<FmvDashboard />)
    // total FMV renders via formatUsd ($2.50M / $400.0k)
    await waitFor(() => expect(screen.getByText("$2.50M")).toBeTruthy())
    expect(screen.getByText("$400.0k")).toBeTruthy()
    // confidence chips: "4.0k High" / "500 Ask only" etc. (formatNumber)
    expect(screen.getByText(/4\.0k High/)).toBeTruthy()
    expect(screen.getAllByText(/Ask only/).length).toBeGreaterThan(0)
    // the "No pipeline data available" empty state must NOT render
    expect(screen.queryByText(/No pipeline data available/i)).toBeNull()
  })
})

// The top-movers filter controls (direction toggle, window options, min/limit
// selects) and the shouldHideTopMovers gate were dark — the mount-only tests
// never touched them.
describe("FmvDashboard — top-movers filter interactions", () => {
  beforeEach(() => {
    fetchMock = routeFetch()
    vi.stubGlobal("fetch", fetchMock)
  })

  it("switching to Losers refetches with direction=losers", async () => {
    render(<FmvDashboard />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    fireEvent.click(screen.getByText("Losers"))
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/fmv/top-movers") && String(c[0]).includes("direction=losers"))).toBe(true),
    )
  })

  it("the window / min-FMV / limit controls each refetch with the new param", async () => {
    render(<FmvDashboard />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    fireEvent.click(screen.getByText("1 day"))
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("window_days=1"))).toBe(true),
    )

    const selects = document.querySelectorAll("select")
    // first select = Min FMV, second = Limit (in DOM order within the filter bar)
    fireEvent.change(selects[0], { target: { value: "25" } })
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("min_fmv=25"))).toBe(true),
    )
    fireEvent.change(selects[1], { target: { value: "50" } })
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("limit=50"))).toBe(true),
    )
  })

  it("hides the whole Top movers section when every active collection is unsupported, and the reset chip restores it", async () => {
    render(<FmvDashboard />)
    await waitFor(() => expect(screen.getByText("Top movers")).toBeTruthy())
    // Pinnacle is in TOP_MOVERS_UNSUPPORTED; selecting only it hides the section.
    fireEvent.click(screen.getByText("Pinnacle"))
    await waitFor(() => expect(screen.queryByText("Top movers")).toBeNull())
    // the "All collections" reset chip clears the selection and brings it back.
    fireEvent.click(screen.getByText("All collections"))
    await waitFor(() => expect(screen.getByText("Top movers")).toBeTruthy())
  })
})

// A mover with a null confidence exercises the ConfidenceBadge "—" arm; a tier
// with a sub-8% share exercises the stacked-bar "no inline label" branch.
describe("FmvDashboard — null confidence + small tier share", () => {
  beforeEach(() => {
    fetchMock = vi.fn(async (url: string) => {
      const u = String(url)
      let body: any = {}
      if (u.includes("/fmv/health")) body = { collections: {}, as_of: "2026-07-28T00:00:00Z" }
      else if (u.includes("/fmv/tier-pulse")) {
        body = {
          rows: [
            { collection: "nba_top_shot", tier: "Legendary", edition_count: 5, total_fmv_usd: 9500, avg_fmv_usd: 1900, median_fmv_usd: 1800, high_conf_count: 5, low_conf_count: 0 },
            // ~5% share -> below the 8% inline-label threshold (bar renders, label blank)
            { collection: "nba_top_shot", tier: "Common", edition_count: 30, total_fmv_usd: 500, avg_fmv_usd: 16, median_fmv_usd: 12, high_conf_count: 1, low_conf_count: 29 },
          ],
        }
      } else if (u.includes("/fmv/top-movers")) {
        body = {
          rows: [
            { rank: 1, collection: "nba_top_shot", edition_id: "3:9", player_name: null, set_name: null, current_fmv_usd: 50, prior_fmv_usd: 50, change_usd: 0, change_pct: 0, current_confidence: null, prior_confidence: null, sales_count_7d: 2 },
          ],
        }
      }
      return { ok: true, json: async () => body } as any
    })
    vi.stubGlobal("fetch", fetchMock)
  })

  it("renders an em dash for a null-confidence mover and a null player/set", async () => {
    const { container } = render(<FmvDashboard />)
    await waitFor(() => expect(screen.getAllByText("Legendary").length).toBeGreaterThan(0))
    // null player_name / set_name fall back to "—" in the edition cell
    expect(container.textContent).toContain("—")
    // small-share Common tier still surfaces as a legend/table label
    expect(screen.getAllByText("Common").length).toBeGreaterThan(0)
  })
})
