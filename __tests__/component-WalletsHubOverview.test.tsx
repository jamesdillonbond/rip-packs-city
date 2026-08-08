// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import WalletsHubOverview, { formatUsd, formatNumber } from "@/components/analytics/WalletsHubOverview"

// WalletsHubOverview was untested (24% branch). It has two exported pure
// formatters (compact $ / count with M/k thresholds and non-finite guards) plus
// a single-fetch component with loading / null-data / with-data / empty-segment
// legs. These pin the formatter thresholds and drive each render leg.

describe("formatUsd", () => {
  it("guards null / non-finite / non-positive as $0", () => {
    expect(formatUsd(null)).toBe("$0")
    expect(formatUsd(undefined)).toBe("$0")
    expect(formatUsd(0)).toBe("$0")
    expect(formatUsd(-5)).toBe("$0")
    expect(formatUsd(Number.NaN)).toBe("$0")
  })
  it("compacts thousands and millions, and leaves small values plain", () => {
    expect(formatUsd(1_500)).toBe("$1.5k")
    expect(formatUsd(2_000_000)).toBe("$2.00M")
    expect(formatUsd(750)).toBe("$750")
  })
})

describe("formatNumber", () => {
  it("guards null / non-finite as 0", () => {
    expect(formatNumber(null)).toBe("0")
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("0")
  })
  it("compacts thousands and millions", () => {
    expect(formatNumber(1_500)).toBe("1.5k")
    expect(formatNumber(3_000_000)).toBe("3.00M")
    expect(formatNumber(42)).toBe("42")
  })
})

function overviewResponse(over: { segments?: Record<string, number>; totals?: Record<string, number> } = {}) {
  return {
    totals: {
      wallets_total: 1500,
      borrowers: 400,
      lenders: 300,
      last_active_within_7d: 900,
      last_active_within_24h: 200,
      total_borrowed_usd: 2_000_000,
      avg_loans_per_borrower: 2,
      avg_loans_per_lender: 3,
      ...over.totals,
    },
    segments: { whale: 10, active: 40, casual: 200, dust: 750, ...over.segments },
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("WalletsHubOverview render", () => {
  it("shows the loading state until the fetch resolves", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {}))) // never resolves
    const { container } = render(<WalletsHubOverview />)
    expect(container.textContent).toContain("Loading wallet overview")
  })

  it("renders the hub with KPI values and segment bars when data arrives", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => overviewResponse() }) as any))
    const { container } = render(<WalletsHubOverview />)
    await waitFor(() => expect(container.textContent).toContain("Wallets hub"))
    expect(container.textContent).toContain("1.5k") // wallets_total 1500
    expect(container.textContent).toContain("$2.00M") // total volume
    // segments present -> the empty-segment message must NOT show
    expect(container.textContent).not.toContain("No segment data available")
  })

  it("shows the empty-segment message when every segment is zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ json: async () => overviewResponse({ segments: { whale: 0, active: 0, casual: 0, dust: 0 } }) }) as any),
    )
    const { container } = render(<WalletsHubOverview />)
    await waitFor(() => expect(container.textContent).toContain("Wallets hub"))
    expect(container.textContent).toContain("No segment data available")
  })

  it("renders nothing when the response lacks totals/segments", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({}) }) as any))
    const { container } = render(<WalletsHubOverview />)
    // loading clears, data stays null -> component returns null (empty).
    await waitFor(() => expect(container.textContent).not.toContain("Loading wallet overview"))
    expect(container.textContent).not.toContain("Wallets hub")
  })
})
