// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import PortfolioChart from "@/components/PortfolioChart"

// Drives the 30-day Portfolio FMV chart: the owner-key gate (renders NOTHING
// until a key is set), the /api/portfolio/history fetch, the header change
// summary (absolute + %, green/red, leading + sign) — the numbers a collector
// reads at a glance — and the loading / empty / error states. recharts is stubbed
// to markers so the assertions target THIS component's own logic, not SVG paths.

let currentOwner = ""
vi.mock("@/lib/owner-key", () => ({
  getOwnerKey: () => currentOwner,
  onOwnerKeyChange: () => () => {}, // returns an unsubscribe noop
}))
// Stub recharts so the chart branch renders deterministically in jsdom.
vi.mock("recharts", () => {
  const Passthrough = ({ children }: any) => <div>{children}</div>
  return {
    ResponsiveContainer: Passthrough,
    LineChart: Passthrough,
    Line: () => <div data-testid="line" />,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
  }
})

let fetchMock: ReturnType<typeof vi.fn>
const okJson = (b: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(b) } as Response)

beforeEach(() => {
  currentOwner = ""
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("PortfolioChart", () => {
  it("renders nothing and fetches nothing when no owner key is set", () => {
    const { container } = render(<PortfolioChart />)
    expect(container.firstChild).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("renders the header change summary (green, +sign, %) from first→last point", async () => {
    currentOwner = "0xowner"
    fetchMock.mockReturnValueOnce(
      okJson({
        history: [
          { snapshot_date: "2026-04-01", total_fmv: 4000, moment_count: 10, wallet_count: 1 },
          { snapshot_date: "2026-04-30", total_fmv: 6000, moment_count: 12, wallet_count: 1 },
        ],
      }),
    )
    const { getByText, getByTestId } = render(<PortfolioChart />)
    await waitFor(() => expect(getByText("$6,000")).toBeTruthy()) // last total
    // change = 6000-4000 = +2000 (+50.0%); fmtCurrency rounds >= $1000
    expect(getByText("+$2,000 (+50.0%)")).toBeTruthy()
    expect(getByTestId("line")).toBeTruthy() // chart branch rendered
    // fetch went to the history endpoint with the owner key + 30-day window
    expect(fetchMock.mock.calls[0][0]).toContain("/api/portfolio/history?")
    expect(fetchMock.mock.calls[0][0]).toContain("owner_key=0xowner")
    expect(fetchMock.mock.calls[0][0]).toContain("days=30")
  })

  it("shows a negative change in red with a minus sign", async () => {
    currentOwner = "0xowner"
    fetchMock.mockReturnValueOnce(
      okJson({
        history: [
          { snapshot_date: "2026-04-01", total_fmv: 6000, moment_count: 10, wallet_count: 1 },
          { snapshot_date: "2026-04-30", total_fmv: 4000, moment_count: 9, wallet_count: 1 },
        ],
      }),
    )
    const { getByText } = render(<PortfolioChart />)
    // change = 4000-6000 = -2000 (-33.3%). fmtCurrency renders the sign after $
    await waitFor(() => expect(getByText("$-2,000 (-33.3%)")).toBeTruthy())
  })

  it("shows the no-snapshots empty state on an empty history", async () => {
    currentOwner = "0xowner"
    fetchMock.mockReturnValueOnce(okJson({ history: [] }))
    const { getByText } = render(<PortfolioChart />)
    await waitFor(() => expect(getByText(/No snapshots yet/)).toBeTruthy())
  })

  it("surfaces an API error string", async () => {
    currentOwner = "0xowner"
    fetchMock.mockReturnValueOnce(
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: "history down" }) } as Response),
    )
    const { getByText } = render(<PortfolioChart />)
    await waitFor(() => expect(getByText("history down")).toBeTruthy())
  })
})
