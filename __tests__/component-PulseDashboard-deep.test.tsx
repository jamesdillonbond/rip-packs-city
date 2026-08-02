// @vitest-environment jsdom
//
// Deep companion to component-PulseDashboard.test.tsx, which is a mount smoke
// test: it stubs KpiCard to null and answers every endpoint with an empty body,
// so it proves the three fetches fire but exercises almost none of the render
// branches. This file drives PulseDashboard with REAL payloads and pins the
// arms that decide what a reader actually sees:
//
//   - the KPI strip's null-vs-populated arms. A missing 24h payload must render
//     "—", never a fabricated "$0"/"0" -- the latter reads as a measured dead
//     market rather than an absent measurement.
//   - the sparkline's empty-vs-populated gate.
//   - the activity feed's two DISTINCT empty messages (loading vs no-match).
//     Conflating them tells the reader the wrong thing about why it is blank.
//   - ActivityRow's anon / linkable-addr / counterparty / details-toggle arms.
//     The "Centralized · anon" chip is an honesty disclosure: Top Shot
//     marketplace sales carry no participant addresses.
//   - the collection-chip and kind-filter active/inactive arms, and the
//     min-size numeric filter -- including a non-numeric entry, which must mean
//     "no filter" rather than blanking the feed on a stray keystroke.
//
// The pure helpers live in lib/analytics-pulse-dashboard-compute and are unit
// tested there; this file asserts the COMPONENT's wiring of them, not their
// internals. recharts needs layout jsdom does not provide, so the chart is
// stubbed to a marker -- the gate ABOVE it is what is pinned here.

import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, screen, waitFor, fireEvent } from "@testing-library/react"

vi.mock("recharts", async () => {
  const React = await import("react")
  const Pass = ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "chart" }, children)
  const Null = () => null
  return {
    ResponsiveContainer: Pass,
    ComposedChart: Pass,
    CartesianGrid: Null,
    XAxis: Null,
    YAxis: Null,
    Tooltip: Null,
    Legend: Null,
    Bar: Null,
  }
})

import PulseDashboard from "@/components/analytics/PulseDashboard"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// formatUsd: >=1000 -> "$125.0k"; formatPrice: >=100 -> "$195";
// formatNumber: <1000 -> "640". Kept in sync with the compute lib on purpose --
// if those thresholds move, this file should red alongside its unit tests.
const SUMMARY_24H = {
  as_of: new Date().toISOString(),
  sales: { volume_usd: 125_000, sales: 640, avg_price_usd: 195.31, unique_buyers: 312 },
  prior_sales: { volume_usd: 100_000, sales: 800 },
  loans: { originations: 40, repayments: 12, settlements: 3, origination_volume_usd: 22_500 },
  prior_loans: { originations: 50, origination_volume_usd: 25_000 },
}

// Top Shot marketplace sale: isAnonymousSale() is true off details.marketplace,
// so the anon chip shows and BOTH address arms stay suppressed even though
// primary_addr is populated.
const ANON_SALE = {
  kind: "sale",
  collection: "topshot",
  occurred_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  amount_usd: 30,
  primary_addr: "0xaaaaaaaaaaaaaaaa",
  counterparty: null,
  details: { marketplace: "topshot", tx_hash: "0xtx_anon" },
}

// Loan with a linkable 16-hex primary addr and a NON-linkable counterparty, so
// both sides of the isLinkableAddr ternary render in one row.
const LOAN_ROW = {
  kind: "loan_originated",
  collection: "allday",
  occurred_at: new Date(Date.now() - 90 * 60_000).toISOString(),
  amount_usd: 5_000,
  primary_addr: "0xbbbbbbbbbbbbbbbb",
  counterparty: "not-an-address",
  details: { tx_hash: "0xtx_loan", term_days: 30, apr_pct: 12 },
}

function stubFetch({
  summary = SUMMARY_24H as unknown,
  hourly = [] as unknown[],
  activity = [] as unknown[],
} = {}) {
  const fn = vi.fn(async (url: string) => {
    const u = String(url)
    const body = u.includes("/pulse/24h")
      ? summary
      : u.includes("/pulse/hourly")
        ? { rows: hourly }
        : { rows: activity }
    return { ok: true, json: async () => body } as any
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

describe("PulseDashboard (deep) — KPI strip null vs populated", () => {
  it("renders real KPI values and sublabels when the 24h payload is present", async () => {
    stubFetch()
    render(<PulseDashboard />)

    await waitFor(() => expect(screen.getByText("$125.0k")).toBeTruthy())
    expect(screen.getByText("640")).toBeTruthy()
    expect(screen.getByText("Avg $195")).toBeTruthy()
    expect(screen.getByText("312 buyers")).toBeTruthy()
    expect(screen.getByText("40")).toBeTruthy()
    expect(screen.getByText("12 repaid · 3 settled")).toBeTruthy()
    expect(screen.getByText("$22.5k")).toBeTruthy()
  })

  it("renders an em dash — never a fabricated $0 — when the 24h payload is null", async () => {
    stubFetch({ summary: null })
    render(<PulseDashboard />)

    await waitFor(() => expect(screen.getByText("Auto-refresh on")).toBeTruthy())
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4)
    expect(screen.queryByText("$0")).toBeNull()
    // Sublabels are undefined on this arm, so they must be absent entirely
    // rather than rendered as zeros.
    expect(screen.queryByText(/buyers$/)).toBeNull()
    expect(screen.queryByText(/repaid ·/)).toBeNull()
  })
})

describe("PulseDashboard (deep) — sparkline empty gate", () => {
  it("shows the placeholder copy when there are no hourly buckets", async () => {
    stubFetch({ hourly: [] })
    render(<PulseDashboard />)
    await waitFor(() =>
      expect(screen.getByText("Hourly buckets populate as activity arrives.")).toBeTruthy()
    )
    expect(screen.queryByTestId("chart")).toBeNull()
  })

  it("renders the chart once buckets exist", async () => {
    stubFetch({
      hourly: [
        { hour: "2026-08-02T10:00:00.000Z", sale_count: 12, loan_count: 3 },
        { hour: "2026-08-02T11:00:00.000Z", sale_count: 20, loan_count: 5 },
      ],
    })
    render(<PulseDashboard />)
    await waitFor(() => expect(screen.getAllByTestId("chart").length).toBeGreaterThan(0))
    expect(screen.queryByText("Hourly buckets populate as activity arrives.")).toBeNull()
  })
})

describe("PulseDashboard (deep) — the two activity empty states are distinct", () => {
  it('settles on "No events match the current filters." with zero rows', async () => {
    stubFetch({ activity: [] })
    render(<PulseDashboard />)
    await waitFor(() =>
      expect(screen.getByText("No events match the current filters.")).toBeTruthy()
    )
    expect(screen.queryByText("Loading activity…")).toBeNull()
  })
})

describe("PulseDashboard (deep) — ActivityRow branches", () => {
  it("flags an anonymous Top Shot sale and suppresses both address arms", async () => {
    stubFetch({ activity: [ANON_SALE] })
    render(<PulseDashboard />)

    await waitFor(() => expect(screen.getByText("Centralized · anon")).toBeTruthy())
    expect(screen.queryByText("addr")).toBeNull()
    expect(screen.queryByText("cp")).toBeNull()
  })

  it("links a linkable addr and renders a non-linkable counterparty as plain text", async () => {
    stubFetch({ activity: [LOAN_ROW] })
    const { container } = render(<PulseDashboard />)

    await waitFor(() => expect(screen.getByText("addr")).toBeTruthy())
    expect(screen.getByText("cp")).toBeTruthy()
    expect(screen.queryByText("Centralized · anon")).toBeNull()

    expect(container.querySelector('a[href="/analytics/wallets/0xbbbbbbbbbbbbbbbb"]')).toBeTruthy()
    expect(screen.getByText("not-an-address")).toBeTruthy()
    expect(container.querySelector('a[href="/analytics/wallets/not-an-address"]')).toBeNull()
  })

  it("toggles the details <pre> open and closed", async () => {
    stubFetch({ activity: [LOAN_ROW] })
    const { container } = render(<PulseDashboard />)

    await waitFor(() => expect(screen.getByText("details")).toBeTruthy())
    expect(container.querySelector("pre")).toBeNull()

    fireEvent.click(screen.getByText("details"))
    await waitFor(() => expect(container.querySelector("pre")).toBeTruthy())
    expect(container.querySelector("pre")!.textContent).toContain("0xtx_loan")

    fireEvent.click(screen.getByText("details"))
    await waitFor(() => expect(container.querySelector("pre")).toBeNull())
  })
})

describe("PulseDashboard (deep) — filters", () => {
  it("toggles a collection chip on then off and refetches each way", async () => {
    const f = stubFetch()
    render(<PulseDashboard />)
    await waitFor(() => expect(screen.getByText("Auto-refresh on")).toBeTruthy())

    fireEvent.click(screen.getByText("Top Shot"))
    await waitFor(() =>
      expect(f.mock.calls.some(([u]) => String(u).includes("collections=topshot"))).toBe(true)
    )

    fireEvent.click(screen.getByText("Top Shot"))
    await waitFor(() =>
      expect(
        f.mock.calls.filter(
          ([u]) => String(u).includes("/pulse/24h") && !String(u).includes("collections=")
        ).length
      ).toBeGreaterThan(1)
    )
  })

  it('the kind filter adds kinds=, and the default "All" leaves it off', async () => {
    const f = stubFetch()
    render(<PulseDashboard />)
    await waitFor(() => expect(screen.getByText("Auto-refresh on")).toBeTruthy())

    expect(
      f.mock.calls.some(
        ([u]) => String(u).includes("/pulse/activity") && String(u).includes("kinds=")
      )
    ).toBe(false)

    fireEvent.click(screen.getByText("Loans"))
    await waitFor(() =>
      expect(
        f.mock.calls.some(
          ([u]) => String(u).includes("/pulse/activity") && String(u).includes("kinds=")
        )
      ).toBe(true)
    )
  })

  it("filters rows by min size, and treats a non-numeric entry as no filter", async () => {
    stubFetch({ activity: [ANON_SALE, LOAN_ROW] })
    const { container } = render(<PulseDashboard />)

    await waitFor(() => expect(container.querySelectorAll("article").length).toBe(2))
    const input = container.querySelector('input[type="number"]') as HTMLInputElement

    // 1000 keeps the $5,000 loan and drops the $30 sale.
    fireEvent.change(input, { target: { value: "1000" } })
    await waitFor(() => expect(container.querySelectorAll("article").length).toBe(1))
    expect(screen.queryByText("Centralized · anon")).toBeNull()

    // NaN -> minSizeNum 0 -> filter disabled. The alternative reading would
    // blank the whole feed on a stray keystroke.
    fireEvent.change(input, { target: { value: "abc" } })
    await waitFor(() => expect(container.querySelectorAll("article").length).toBe(2))
  })
})

describe("PulseDashboard (deep) — network failure is soft", () => {
  it("clears the loading copy and keeps the shell when every fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")))
    render(<PulseDashboard />)

    // The catch arm must still clear loading, or the feed sits on
    // "Loading activity…" forever and reads as a hang rather than an outage.
    await waitFor(() => expect(screen.getByText("Auto-refresh on")).toBeTruthy())
    expect(screen.getByText("No events match the current filters.")).toBeTruthy()
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4)
  })
})
