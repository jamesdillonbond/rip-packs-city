// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import PortfolioSparkline from "@/components/profile/PortfolioSparkline"

// Drives the 30d portfolio sparkline: the /api/profile/portfolio-history fetch,
// the points build (historical snapshots + a live "today" point from currentFmv,
// dropping non-positive), the empty state (< 2 points), the 30D-change readout +
// the onChange(pct) callback, and that a real SVG path renders with data.

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

describe("PortfolioSparkline", () => {
  it("shows the empty state and reports null change when there is < 2 points", async () => {
    fetchMock.mockReturnValueOnce(okJson({ snapshots: [] }))
    const onChange = vi.fn()
    const { getByText } = render(
      <PortfolioSparkline ownerKey="0xowner" currentFmv={1000} onChange={onChange} />,
    )
    await waitFor(() => expect(getByText(/Sparkline builds as you load wallets/)).toBeTruthy())
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it("renders the 30D change and calls onChange(pct) with one historical point + today", async () => {
    fetchMock.mockReturnValueOnce(
      okJson({ snapshots: [{ snapshot_date: "2026-04-01", total_fmv: 800, moment_count: 5, wallet_count: 1 }] }),
    )
    const onChange = vi.fn()
    const { container } = render(
      <PortfolioSparkline ownerKey="0xowner" currentFmv={1000} onChange={onChange} />,
    )
    // change = 1000 - 800 = +200 (+25.0%)
    await waitFor(() => expect(container.textContent).toContain("+25.0%"))
    expect(container.querySelector("path")).toBeTruthy() // the sparkline line renders
    expect(onChange).toHaveBeenCalledWith(25)
  })

  it("does not fetch when ownerKey is empty", () => {
    render(<PortfolioSparkline ownerKey="" currentFmv={1000} />)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
