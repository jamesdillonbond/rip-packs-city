// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import HeldTimeDistributionCard from "@/components/analytics/HeldTimeDistributionCard"

// Drives the held-time card: fetch /api/wallet-hold-time, the null-render on
// missing/non-ok/zero-total, the Top-Shot-only "acquisition_data_unavailable"
// reason message, and the chart branch ("N moments tracked" + a rendered bar).
// recharts is stubbed to markers.

vi.mock("recharts", () => {
  const P = ({ children }: any) => <div>{children}</div>
  return {
    ResponsiveContainer: P, BarChart: P, Bar: () => <div data-testid="bar" />,
    XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null,
  }
})

let fetchMock: ReturnType<typeof vi.fn>
const okJson = (b: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(b) } as Response)

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("HeldTimeDistributionCard", () => {
  it("renders the bucket chart with the tracked-count header", async () => {
    fetchMock.mockReturnValueOnce(okJson({ total: 120, buckets: [{ bucket: "0-7d", count: 40 }, { bucket: "8-30d", count: 80 }] }))
    const { getByText, getByTestId } = render(<HeldTimeDistributionCard wallet="0xW" urlSlug="nba-top-shot" />)
    await waitFor(() => expect(getByText("Held Time Distribution")).toBeTruthy())
    expect(getByText("120 moments tracked")).toBeTruthy()
    expect(getByTestId("bar")).toBeTruthy()
    expect(fetchMock.mock.calls[0][0]).toContain("collection=nba-top-shot")
  })

  it("renders the Top-Shot-only reason message", async () => {
    fetchMock.mockReturnValueOnce(okJson({ reason: "acquisition_data_unavailable" }))
    const { getByText } = render(<HeldTimeDistributionCard wallet="0xW" urlSlug="nfl-all-day" />)
    await waitFor(() => expect(getByText(/Hold time tracking is Top Shot only today/)).toBeTruthy())
  })

  it("renders nothing when total is 0", async () => {
    fetchMock.mockReturnValueOnce(okJson({ total: 0, buckets: [] }))
    const { container } = render(<HeldTimeDistributionCard wallet="0xW" urlSlug="nba-top-shot" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it("renders nothing on a non-ok fetch", async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: false, status: 500 } as Response))
    const { container } = render(<HeldTimeDistributionCard wallet="0xW" urlSlug="nba-top-shot" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })
})
