// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest"
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react"
import FmvHistoryChart, { fmtUsd, fmtDay } from "@/components/entity/FmvHistoryChart"

// Pins the entity edition FMV-history chart. Two risks it guards:
//   1. The money formatter — an axis/tooltip that renders $0.00 or $NaN for a
//      missing FMV instead of "—" (the silent-$0 class), only reachable through
//      recharts' tick/tooltip callbacks otherwise.
//   2. The "too few sales to chart" empty state (<=2 usable points), so a thin
//      edition renders an honest placeholder rather than a misleading 1-point
//      line — and the 90d toggle re-fetch degrading to [] on error.

afterEach(cleanup)

describe("FmvHistoryChart.fmtUsd", () => {
  it("returns — for null / undefined / non-finite (never $0.00 or $NaN)", () => {
    expect(fmtUsd(null)).toBe("—")
    expect(fmtUsd(undefined)).toBe("—")
    expect(fmtUsd(Number.NaN)).toBe("—")
    expect(fmtUsd(Number.POSITIVE_INFINITY)).toBe("—")
  })
  it("uses cents below $100", () => {
    expect(fmtUsd(0)).toBe("$0.00")
    expect(fmtUsd(4.2)).toBe("$4.20")
    expect(fmtUsd(99.99)).toBe("$99.99")
  })
  it("rounds whole dollars in [100,1000)", () => {
    expect(fmtUsd(100)).toBe("$100")
    expect(fmtUsd(249.6)).toBe("$250")
  })
  it("uses $Xk at/above 1000", () => {
    expect(fmtUsd(1000)).toBe("$1.0k")
    expect(fmtUsd(2500)).toBe("$2.5k")
  })
})

describe("FmvHistoryChart.fmtDay", () => {
  it("formats a valid ISO date as 'Mon D'", () => {
    expect(fmtDay("2026-07-04T00:00:00Z")).toMatch(/Jul\s+\d+/)
  })
  it("returns the raw input for an unparseable date", () => {
    expect(fmtDay("not-a-date")).toBe("not-a-date")
  })

  // Regression: `day` from the RPC is a date-only "YYYY-MM-DD" bucket (DATE(computed_at)),
  // which parses as UTC midnight. Without timeZone:"UTC" the label slips to the previous
  // calendar day for viewers west of UTC. Force a US zone so this bites regardless of the
  // CI runner's TZ (Node re-reads process.env.TZ for subsequent Date formatting).
  it("renders the UTC calendar day for a date-only string, even west of UTC", () => {
    const origTZ = process.env.TZ
    process.env.TZ = "America/Los_Angeles"
    try {
      expect(fmtDay("2026-07-01")).toBe("Jul 1")
      expect(fmtDay("2026-01-01")).toBe("Jan 1")
    } finally {
      process.env.TZ = origTZ
    }
  })
})

const pt = (fmv: number | null, day: string) => ({
  day,
  fmv_usd: fmv,
  wap_usd: fmv,
  floor_usd: fmv,
  confidence: "HIGH" as const,
  sales_count_30d: 3,
  computed_at: day,
})

describe("FmvHistoryChart render", () => {
  it("shows the empty-state when 2 or fewer usable points exist", () => {
    render(
      <FmvHistoryChart
        collectionUrlSlug="nba-top-shot"
        routeSlug="1-1"
        initial={[pt(10, "2026-07-01"), pt(null, "2026-07-02")]}
      />,
    )
    expect(screen.getByText(/too few sales to chart/i)).toBeTruthy()
  })

  it("renders the range toggle buttons", () => {
    render(<FmvHistoryChart collectionUrlSlug="nba-top-shot" routeSlug="1-1" initial={[]} />)
    expect(screen.getByRole("button", { name: "30d" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "90d" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "365d" })).toBeTruthy()
  })

  it("renders the chart (not the empty state) when more than 2 usable points exist", () => {
    render(
      <FmvHistoryChart
        collectionUrlSlug="nba-top-shot"
        routeSlug="1-1"
        initial={[pt(10, "2026-07-01"), pt(12, "2026-07-02"), pt(14, "2026-07-03"), pt(null, "2026-07-04")]}
      />,
    )
    // >2 usable points -> the chart container branch, not the placeholder.
    expect(screen.queryByText(/too few sales to chart/i)).toBeNull()
  })

  it("adopts the light-theme axis palette when data-theme=light", () => {
    document.documentElement.dataset.theme = "light"
    try {
      render(
        <FmvHistoryChart
          collectionUrlSlug="nba-top-shot"
          routeSlug="1-1"
          initial={[pt(10, "2026-07-01"), pt(12, "2026-07-02"), pt(14, "2026-07-03")]}
        />,
      )
      // The effect flips `light` true after mount; the branch executes without crash.
      expect(screen.queryByText(/too few sales to chart/i)).toBeNull()
    } finally {
      delete document.documentElement.dataset.theme
    }
  })
})

describe("FmvHistoryChart 90d toggle re-fetch", () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("fetches the 90d window on toggle and degrades to the empty-state on a fetch error", async () => {
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }))
    render(<FmvHistoryChart collectionUrlSlug="nba-top-shot" routeSlug="1-1" initial={[pt(10, "2026-07-01")]} />)
    fireEvent.click(screen.getByRole("button", { name: "90d" }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain("part=fmv-history")
    expect(url).toContain("days=90")
    // A 500 must NOT throw; it falls back to [] → the honest empty-state.
    await waitFor(() => {
      expect(screen.getByText(/too few sales to chart/i)).toBeTruthy()
    })
  })

  it("renders the chart from the 90d window on a successful re-fetch", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { day: "2026-05-01", fmv_usd: 10, wap_usd: 10, floor_usd: 10, confidence: "HIGH", sales_count_30d: 4, computed_at: "2026-05-01" },
          { day: "2026-05-02", fmv_usd: 12, wap_usd: 12, floor_usd: 12, confidence: "HIGH", sales_count_30d: 4, computed_at: "2026-05-02" },
          { day: "2026-05-03", fmv_usd: 14, wap_usd: 14, floor_usd: 14, confidence: "HIGH", sales_count_30d: 4, computed_at: "2026-05-03" },
        ]),
        { status: 200 },
      ),
    )
    render(<FmvHistoryChart collectionUrlSlug="nba-top-shot" routeSlug="1-1" initial={[pt(10, "2026-07-01")]} />)
    fireEvent.click(screen.getByRole("button", { name: "90d" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    // 3 usable points arrived -> chart branch, no empty state.
    await waitFor(() => expect(screen.queryByText(/too few sales to chart/i)).toBeNull())
  })

  it("degrades to the empty-state when the re-fetch returns a non-array payload", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ oops: true }), { status: 200 }))
    render(<FmvHistoryChart collectionUrlSlug="nba-top-shot" routeSlug="1-1" initial={[pt(10, "2026-07-01")]} />)
    fireEvent.click(screen.getByRole("button", { name: "90d" }))
    // Array.isArray(rows) ? rows : [] -> [] -> empty state.
    await waitFor(() => expect(screen.getByText(/too few sales to chart/i)).toBeTruthy())
  })

  it("resets to the initial series when toggling back to 30d (no re-fetch)", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))
    render(<FmvHistoryChart collectionUrlSlug="nba-top-shot" routeSlug="1-1" initial={[pt(10, "2026-07-01")]} />)
    fireEvent.click(screen.getByRole("button", { name: "90d" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole("button", { name: "30d" }))
    // days===30 short-circuits to setData(initial); no additional fetch fires.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })
})
