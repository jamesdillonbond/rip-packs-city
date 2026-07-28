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
})
