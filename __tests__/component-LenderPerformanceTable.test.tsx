// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, waitFor } from "@testing-library/react"

// Pins the Lender Performance table's money + RISK display — fmtUsd/fmtNumber/
// fmtPct plus the two classification ladders that ARE the table's judgement:
//   yieldClass  — positive yield green / negative red / flat muted
//   defaultRateClass — >=20% red / >=10% amber / else muted
// A threshold or format slip here silently mis-signals a lender's risk. Rendered
// via the DOM with fetch + the username-resolver module stubbed (no source
// change).

vi.mock("@/lib/analytics/username-resolver", () => ({
  useResolveUsernames: () => ({}),
  displayName: (addr: string) => (addr || "").slice(0, 6) + "…" + (addr || "").slice(-4),
  truncateAddress: (addr: string) => (addr || "").slice(0, 6) + "…" + (addr || "").slice(-4),
}))

import LenderPerformanceTable from "@/components/analytics/LenderPerformanceTable"

const row = (over: Record<string, any>) => ({
  rank: 1,
  addr: "0xlender00000001",
  total_loans: 1200,
  total_principal_usd: 2_500_000,
  repaid_loans: 1000,
  repaid_principal_usd: 2_000_000,
  repaid_collected_usd: 2_100_000,
  interest_earned_usd: 4200,
  default_loans: 5,
  default_principal_usd: 100,
  realized_yield_pct: 12.5,
  default_rate_pct: 5,
  active_loans: 3,
  ...over,
})

const styleOf = (text: string) => screen.getByText(text).getAttribute("class") || ""

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ rows: [] }) }) as any)
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("LenderPerformanceTable", () => {
  it("renders the empty state when no lenders qualify", async () => {
    render(<LenderPerformanceTable collections={["topshot"]} />)
    await waitFor(() => expect(screen.getByText(/No qualifying lenders/i)).toBeTruthy())
  })

  it("formats money/number/pct and colors a positive yield green", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ rows: [row({})] }) } as any)
    render(<LenderPerformanceTable collections={["topshot"]} />)
    await waitFor(() => expect(screen.getByText("$2.50M")).toBeTruthy()) // total_principal
    expect(screen.getByText("1.2k")).toBeTruthy() // total_loans fmtNumber
    expect(screen.getByText("$4.2k")).toBeTruthy() // interest 4200 -> $4.2k
    // realized_yield 12.5 -> "12.50%", green
    expect(styleOf("12.50%")).toContain("emerald")
  })

  it("colors default rate by band: >=20 red, >=10 amber, <10 muted", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        rows: [
          row({ rank: 1, addr: "0xa000000000001", default_rate_pct: 25, realized_yield_pct: -3 }),
          row({ rank: 2, addr: "0xb000000000002", default_rate_pct: 15, realized_yield_pct: 0 }),
          row({ rank: 3, addr: "0xc000000000003", default_rate_pct: 5, realized_yield_pct: 8 }),
        ],
      }),
    } as any)
    render(<LenderPerformanceTable collections={["topshot"]} />)
    await waitFor(() => expect(screen.getByText("25.00%")).toBeTruthy())
    expect(styleOf("25.00%")).toContain("rose") // >=20 danger
    expect(styleOf("15.00%")).toContain("amber") // >=10 warn
    // 5.00% appears as a default rate (muted) — assert it's NOT flagged red/amber
    const five = styleOf("5.00%")
    expect(five).not.toContain("rose")
    expect(five).not.toContain("amber")
    // negative yield -3 -> red
    expect(styleOf("-3.00%")).toContain("rose")
  })

  it("renders — for a null yield / null default rate (never $NaN%)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ rows: [row({ realized_yield_pct: null, default_rate_pct: null })] }),
    } as any)
    render(<LenderPerformanceTable collections={["topshot"]} />)
    await waitFor(() => expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2))
  })

  it("refetches when the collections prop changes and scopes the query", async () => {
    const { rerender } = render(<LenderPerformanceTable collections={["topshot"]} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(String(fetchMock.mock.calls[0][0])).toContain("collections=topshot")
    rerender(<LenderPerformanceTable collections={["allday", "golazos"]} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(decodeURIComponent(String(fetchMock.mock.calls[1][0]))).toContain("collections=allday,golazos")
  })

  it("degrades to the empty state on a non-ok fetch (no crash)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) } as any)
    render(<LenderPerformanceTable collections={["topshot"]} />)
    await waitFor(() => expect(screen.getByText(/No qualifying lenders/i)).toBeTruthy())
  })
})
