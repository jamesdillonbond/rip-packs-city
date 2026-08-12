// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"

// The long-horizon (1Y / ALL) arm of FmvHistoryChart, which reads SALE PRINTS
// rather than FMV snapshots.
//
// It exists because fmv_snapshots only begin 2026-03-31, so the old "365d" FMV
// chip could never show a year — it showed ~4.5 months and looked like a year.
// `sales` goes back to 2020. The assertions below pin the things that make that
// swap honest rather than merely longer:
//   · the chip switches SOURCE (part=sale-history), not just the day count
//   · the caption says which quantity is plotted and at what bucket grain
//   · a monthly bucket is not labelled like a single day
//   · a failed fetch is distinguishable from a genuinely thin market

import FmvHistoryChart, { fmtBucket } from "@/components/entity/FmvHistoryChart"

const fmvPt = (fmv: number, day: string) => ({
  day, fmv_usd: fmv, wap_usd: fmv, floor_usd: fmv,
  confidence: "HIGH", sales_count_30d: 3, computed_at: day,
})

const salePt = (bucket: string, median: number, grain = "month", extra: Partial<any> = {}) => ({
  bucket, median_usd: median, low_usd: median - 5, high_usd: median + 40,
  sales_count: 7, grain, ...extra,
})

let fetchMock: any

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const initial = [fmvPt(10, "2026-07-01"), fmvPt(11, "2026-07-02"), fmvPt(12, "2026-07-03")]

function renderChart() {
  return render(<FmvHistoryChart collectionUrlSlug="nba-top-shot" routeSlug="5:145" initial={initial} />)
}

describe("FmvHistoryChart — sale-print history", () => {
  it("switches SOURCE, not just the window, when 1Y is chosen", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([salePt("2025-09-01", 50, "week"), salePt("2025-10-01", 60, "week"), salePt("2025-11-01", 70, "week")]), { status: 200 })
    )
    renderChart()
    fireEvent.click(screen.getByRole("button", { name: "1Y" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain("part=sale-history")
    expect(url).toContain("days=365")
    expect(url).not.toContain("part=fmv-history")
  })

  it("asks for all time with the days=0 sentinel on ALL", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([salePt("2020-07-01", 20), salePt("2020-08-01", 45), salePt("2020-09-01", 50)]), { status: 200 })
    )
    renderChart()
    fireEvent.click(screen.getByRole("button", { name: "ALL" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(String(fetchMock.mock.calls[0][0])).toContain("days=0")
  })

  it("captions the plotted quantity and the bucket grain, not just a date range", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([salePt("2020-07-01", 20), salePt("2020-08-01", 45), salePt("2020-09-01", 50)]), { status: 200 })
    )
    renderChart()
    // Before the switch it must say it is showing an ESTIMATE.
    expect(screen.getByText(/ESTIMATED FMV/i)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "ALL" }))
    await waitFor(() => expect(screen.getByText(/MEDIAN SALE PRICE/i)).toBeTruthy())
    // Grain comes from the RPC payload, so the label is measured not assumed.
    expect(screen.getByText(/monthly/i)).toBeTruthy()
    expect(screen.getByText(/ACTUAL PRINTS/i)).toBeTruthy()
  })

  it("renders the chart rather than the thin-market empty state when buckets exist", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([salePt("2020-07-01", 20), salePt("2020-08-01", 45), salePt("2020-09-01", 50)]), { status: 200 })
    )
    renderChart()
    fireEvent.click(screen.getByRole("button", { name: "ALL" }))
    await waitFor(() => expect(screen.queryByText(/too few recorded sales/i)).toBeNull())
  })

  it("says 'too few recorded sales' — a market statement — only when the window is genuinely thin", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([salePt("2020-07-01", 20)]), { status: 200 }))
    renderChart()
    fireEvent.click(screen.getByRole("button", { name: "ALL" }))
    await waitFor(() => expect(screen.getByText(/too few recorded sales/i)).toBeTruthy())
  })

  it("distinguishes a FAILED fetch from a thin market", async () => {
    // The whole point: a 500 must not claim the edition has no sales.
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }))
    renderChart()
    fireEvent.click(screen.getByRole("button", { name: "ALL" }))
    await waitFor(() => expect(screen.getByText(/Couldn.t load price history/i)).toBeTruthy())
    expect(screen.queryByText(/too few recorded sales/i)).toBeNull()
  })

  it("tolerates a non-array payload without throwing", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "nope" }), { status: 200 }))
    renderChart()
    fireEvent.click(screen.getByRole("button", { name: "ALL" }))
    await waitFor(() => expect(screen.getByText(/too few recorded sales/i)).toBeTruthy())
  })

  it("returns to the FMV source and caption when a short range is reselected", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([salePt("2020-07-01", 20), salePt("2020-08-01", 45), salePt("2020-09-01", 50)]), { status: 200 })
    )
    renderChart()
    fireEvent.click(screen.getByRole("button", { name: "ALL" }))
    await waitFor(() => expect(screen.getByText(/MEDIAN SALE PRICE/i)).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "30d" }))
    await waitFor(() => expect(screen.getByText(/ESTIMATED FMV/i)).toBeTruthy())
  })
})

describe("fmtBucket", () => {
  it("labels a monthly bucket by month and year, never as a single day", () => {
    // "Jul 1" for a bucket summarising all of July 2020 would read as one day.
    expect(fmtBucket("2020-07-01", "month")).toBe("Jul 20")
  })

  it("labels day and week buckets by month and day", () => {
    expect(fmtBucket("2026-07-04", "day")).toBe("Jul 4")
    expect(fmtBucket("2026-07-04", "week")).toBe("Jul 4")
  })

  it("formats in UTC so the label doesn't slip a day for US viewers", () => {
    expect(fmtBucket("2026-01-01", "day")).toBe("Jan 1")
  })

  it("returns the raw string for an unparseable date instead of 'Invalid Date'", () => {
    expect(fmtBucket("not-a-date", "month")).toBe("not-a-date")
  })

  it("falls back to day formatting when grain is missing", () => {
    expect(fmtBucket("2026-07-04", null)).toBe("Jul 4")
    expect(fmtBucket("2026-07-04", undefined)).toBe("Jul 4")
  })
})
