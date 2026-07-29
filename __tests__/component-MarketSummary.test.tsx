// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import MarketSummary from "@/components/MarketSummary"

// Drives the per-collection Market Summary tiles: fetch /api/market/summary, the
// single market-overview-view telemetry beacon on mount, the fmtCurrency banding
// (incl. the $0 special case), fmtInt, the render-only-present-collections rule,
// and the error state.

const trackMock = vi.fn()
vi.mock("@/lib/telemetry/track", () => ({ track: (...a: unknown[]) => trackMock(...a) }))

let fetchMock: ReturnType<typeof vi.fn>
const okJson = (b: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(b) } as Response)

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
  trackMock.mockClear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const stats = {
  sales_24h: 40,
  sales_7d: 300,
  volume_24h_usd: 12500, // → "$12,500"
  volume_7d_usd: 0, // → "$0" (the special-cased branch)
  avg_price_7d: 312.5, // → "$312.50"
  distinct_buyers_7d: 88,
  editions_total: 1200,
  editions_with_fmv: 900,
}

describe("MarketSummary", () => {
  it("fires the telemetry beacon exactly once and renders tiles for PRESENT collections only", async () => {
    // summary carries only Top Shot → only that tile renders, others skipped
    fetchMock.mockReturnValueOnce(okJson({ summary: { nba_top_shot: stats } }))
    const { getByText, queryByText } = render(<MarketSummary />)
    await waitFor(() => expect(getByText("NBA Top Shot")).toBeTruthy())
    expect(trackMock).toHaveBeenCalledTimes(1)
    expect(trackMock).toHaveBeenCalledWith("market-overview-view")
    // money banding + the $0 special case + fmtInt
    expect(getByText("$12,500")).toBeTruthy()
    expect(getByText("$0")).toBeTruthy()
    expect(getByText("$312.50")).toBeTruthy()
    expect(getByText("1,200")).toBeTruthy()
    // a collection absent from the payload renders no tile
    expect(queryByText("UFC Strike")).toBeNull()
  })

  it("renders the error string and no tiles when the API errors", async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({ error: "unavailable" }) } as Response),
    )
    const { getByText, queryByText } = render(<MarketSummary />)
    await waitFor(() => expect(getByText("unavailable")).toBeTruthy())
    expect(queryByText("NBA Top Shot")).toBeNull()
  })
})
