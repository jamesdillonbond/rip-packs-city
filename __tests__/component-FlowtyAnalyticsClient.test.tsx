// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"
import FlowtyAnalyticsClient from "@/app/admin/flowty-analytics/FlowtyAnalyticsClient"

// `admin/flowty-analytics` converted to a `*Client.tsx` so the component gate measures it —
// ~1,050 lines of token gate, chart pivots and leaderboard rendering that matched neither
// gate's include.
//
// ⚠ THE CONVERSION FOUND A LIVE DEFECT, and it is a shape this repo had not yet recorded:
// not a failed read rendering as an empty answer, but a failed read rendering as the WRONG
// answer. `load()` returns early on failure without touching `data`, so switching the
// collection pill to "Top Shot" and having that request fail left every chart, every KPI
// tile and all five leaderboards showing the PREVIOUS filter's numbers under the new
// filter's label. The error banner appears above them, so the page contradicted itself —
// and unlike a blank panel, wrong numbers read as a real answer.
//
// The second half is subtler and would have survived a copy fix: `lineCollections` was
// derived from the PILLS, so a stale all-collections payload rendered with a single Top Shot
// line — silently dropping four collections' data out of every chart. It now derives from
// `data.meta.collection`, i.e. from the payload actually on screen.

// recharts is stubbed to markers. The Line/Bar stubs surface their `dataKey` so the
// lineCollections derivation is assertable, and the axis/tooltip stubs invoke their
// formatter props so those lambdas are driven rather than merely constructed.
vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    ResponsiveContainer: Pass,
    LineChart: ({ children, data }: { children?: React.ReactNode; data?: unknown[] }) => (
      <div data-testid="chart" data-rows={Array.isArray(data) ? data.length : 0}>
        {children}
      </div>
    ),
    BarChart: ({ children, data }: { children?: React.ReactNode; data?: unknown[] }) => (
      <div data-testid="chart" data-rows={Array.isArray(data) ? data.length : 0}>
        {children}
      </div>
    ),
    Line: ({ dataKey }: { dataKey?: string }) => <div data-testid="series" data-key={dataKey} />,
    Bar: ({ dataKey }: { dataKey?: string }) => <div data-testid="series" data-key={dataKey} />,
    CartesianGrid: () => null,
    Legend: () => null,
    // Drive the tickFormatter lambdas (`(v) => fmtCurrency(Number(v))`).
    XAxis: () => null,
    YAxis: ({ tickFormatter }: { tickFormatter?: (v: unknown) => string }) => (
      <div data-testid="ytick">{tickFormatter ? tickFormatter(1500) : ""}</div>
    ),
    // Drive currencyFormatter / intFormatter, which are cast through `never` at
    // the boundary and so are otherwise never called by anything.
    Tooltip: ({ formatter }: { formatter?: (v: unknown) => string }) => (
      <div data-testid="tipfmt">{typeof formatter === "function" ? formatter(2500) : ""}</div>
    ),
  }
})

vi.mock("next/link", () => ({
  default: ({ children, href }: { children?: React.ReactNode; href?: string } & Record<string, unknown>) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}))

function json(status: number, body: unknown, ok = status < 400) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
}

const SUMMARY = {
  salesAllTimeVolumeUsd: 1_250_000,
  salesAllTimeTxCount: 42_000,
  loansAllTimeVolumeUsd: 310_000,
  loansAllTimeCount: 900,
  salesPeriodVolumeUsd: 12_500,
  salesPeriodTxCount: 310,
  loansPeriodVolumeUsd: 4_200,
  loansPeriodCount: 18,
  periodFirstTimeBuyers: 7,
  periodFirstTimeSellers: 5,
  periodFirstTimeLenders: 3,
  periodFirstTimeBorrowers: 2,
}

const EMPTY_BOARDS = {
  topBuyers: [],
  topSellers: [],
  topNetMarketplace: [],
  topLenders: [],
  topBorrowers: [],
}

function payload(over: Record<string, unknown> = {}) {
  return {
    meta: { collection: "all", period: "monthly", start: "2026-01-01", end: "2026-06-01", bucket: "month" },
    refreshedAt: "2026-06-01T00:00:00Z",
    dataCaveats: [],
    summary: SUMMARY,
    salesTimeseries: [
      { bucket: "2026-04", collection: "topshot", txCount: 10, grossVolumeUsd: 500, activeBuyers: 4, activeSellers: 3 },
      { bucket: "2026-05", collection: "allday", txCount: 6, grossVolumeUsd: 220, distinctBuyers: 2, distinctSellers: 1 },
    ],
    loansTimeseries: [
      { bucket: "2026-04", collection: "topshot", loansFunded: 3, principalFundedUsd: 900, activeLenders: 2, activeBorrowers: 2 },
    ],
    activations: [],
    leaderboards: EMPTY_BOARDS,
    ...over,
  }
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  window.localStorage.clear()
  fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => json(200, payload()))
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ─── Token gate ──────────────────────────────────────────────────────────────

describe("FlowtyAnalyticsClient — token gate", () => {
  it("shows the sign-in gate when no token is stored, and does not fetch", async () => {
    render(<FlowtyAnalyticsClient />)
    await screen.findByPlaceholderText("RPC_ADMIN_TOKEN")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("goes straight to the dashboard when a token is already stored", async () => {
    window.localStorage.setItem("rpc_admin_token", "stored-token")
    render(<FlowtyAnalyticsClient />)
    await screen.findByText("Sales Volume")
    expect(screen.queryByPlaceholderText("RPC_ADMIN_TOKEN")).toBeNull()
  })

  it("sends the stored token as a bearer", async () => {
    window.localStorage.setItem("rpc_admin_token", "stored-token")
    render(<FlowtyAnalyticsClient />)
    await screen.findByText("Sales Volume")
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer stored-token")
  })

  it("refuses an empty token without calling the API", async () => {
    render(<FlowtyAnalyticsClient />)
    fireEvent.click(await screen.findByRole("button", { name: /sign in/i }))
    await screen.findByText("Token required")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("trims the pasted token before probing", async () => {
    render(<FlowtyAnalyticsClient />)
    fireEvent.change(await screen.findByPlaceholderText("RPC_ADMIN_TOKEN"), { target: { value: "  padded  " } })
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer padded")
  })

  it("reports a rejected token as invalid rather than as a generic failure", async () => {
    fetchMock.mockResolvedValue(json(401, {}))
    render(<FlowtyAnalyticsClient />)
    fireEvent.change(await screen.findByPlaceholderText("RPC_ADMIN_TOKEN"), { target: { value: "bad" } })
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }))
    await screen.findByText("Invalid token")
    expect(window.localStorage.getItem("rpc_admin_token")).toBeNull()
  })

  it("distinguishes a server failure from a rejected token", async () => {
    fetchMock.mockResolvedValue(json(503, {}))
    render(<FlowtyAnalyticsClient />)
    fireEvent.change(await screen.findByPlaceholderText("RPC_ADMIN_TOKEN"), { target: { value: "good" } })
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }))
    await screen.findByText("HTTP 503")
    // ⚠ A 503 says nothing about the token — storing it would be right, but
    // signing the operator in on an unverified token is worse. Neither happens.
    expect(window.localStorage.getItem("rpc_admin_token")).toBeNull()
  })

  it("surfaces a thrown fetch as its message", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"))
    render(<FlowtyAnalyticsClient />)
    fireEvent.change(await screen.findByPlaceholderText("RPC_ADMIN_TOKEN"), { target: { value: "good" } })
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }))
    await screen.findByText("socket hang up")
  })

  it("falls back to a generic message when the thrown value is not an Error", async () => {
    fetchMock.mockRejectedValue("nope")
    render(<FlowtyAnalyticsClient />)
    fireEvent.change(await screen.findByPlaceholderText("RPC_ADMIN_TOKEN"), { target: { value: "good" } })
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }))
    await screen.findByText("Network error")
  })

  it("stores the token and enters the dashboard on a good probe", async () => {
    render(<FlowtyAnalyticsClient />)
    fireEvent.change(await screen.findByPlaceholderText("RPC_ADMIN_TOKEN"), { target: { value: "good" } })
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }))
    await screen.findByText("Sales Volume")
    expect(window.localStorage.getItem("rpc_admin_token")).toBe("good")
  })

  it("submits on Enter", async () => {
    render(<FlowtyAnalyticsClient />)
    const input = await screen.findByPlaceholderText("RPC_ADMIN_TOKEN")
    fireEvent.change(input, { target: { value: "good" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await screen.findByText("Sales Volume")
  })

  it("ignores other keys", async () => {
    render(<FlowtyAnalyticsClient />)
    const input = await screen.findByPlaceholderText("RPC_ADMIN_TOKEN")
    fireEvent.change(input, { target: { value: "good" } })
    fireEvent.keyDown(input, { key: "a" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("clears the stored token on sign-out and returns to the gate", async () => {
    window.localStorage.setItem("rpc_admin_token", "stored-token")
    render(<FlowtyAnalyticsClient />)
    await screen.findByText("Sales Volume")
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }))
    await screen.findByPlaceholderText("RPC_ADMIN_TOKEN")
    expect(window.localStorage.getItem("rpc_admin_token")).toBeNull()
  })

  it("a 401 on the dashboard load signs the operator out rather than showing a bare error", async () => {
    window.localStorage.setItem("rpc_admin_token", "revoked")
    fetchMock.mockResolvedValue(json(401, {}))
    render(<FlowtyAnalyticsClient />)
    await screen.findByPlaceholderText("RPC_ADMIN_TOKEN")
    expect(window.localStorage.getItem("rpc_admin_token")).toBeNull()
  })
})

// ─── The defect: a failed refresh must not relabel the previous filter ───────

describe("FlowtyAnalyticsClient — a failed refresh must not relabel the previous filter", () => {
  async function mountThenFailRefresh(next: () => Response) {
    window.localStorage.setItem("rpc_admin_token", "t")
    render(<FlowtyAnalyticsClient />)
    await screen.findByText("Sales Volume")
    fetchMock.mockImplementation(async () => next())
    fireEvent.click(screen.getByRole("button", { name: "Top Shot" }))
    return waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1))
  }

  it("says the numbers below belong to the previous filter", async () => {
    await mountThenFailRefresh(() => json(503, { error: "statement timeout" }))
    const notice = await screen.findByTestId("stale-filter-notice")
    expect(notice.textContent).toMatch(/still the/i)
    expect(notice.textContent).toMatch(/All · monthly/)
    expect(notice.textContent).toMatch(/not the\s+numbers for the filter shown above/i)
  })

  it("keeps the charts on screen — last-good beats a blank dashboard", async () => {
    await mountThenFailRefresh(() => json(503, { error: "statement timeout" }))
    await screen.findByTestId("stale-filter-notice")
    expect(screen.getByText("Sales Volume")).toBeTruthy()
  })

  it("still draws every collection's line, not just the newly-picked one", async () => {
    // ⚠ The half a copy-only fix would have missed. `lineCollections` derived
    // from the PILLS would render a single `topshot` series over an
    // all-collections payload, dropping four collections out of every chart.
    await mountThenFailRefresh(() => json(503, { error: "statement timeout" }))
    await screen.findByTestId("stale-filter-notice")
    const keys = new Set(screen.getAllByTestId("series").map((n) => n.getAttribute("data-key")))
    expect(keys).toEqual(new Set(["topshot", "allday", "golazos", "ufc", "pinnacle"]))
  })

  it("shows the driver-supplied error beside the stale notice", async () => {
    await mountThenFailRefresh(() => json(503, { error: "statement timeout" }))
    await screen.findByText("statement timeout")
  })

  it("falls back to the status when the failure body carries no error", async () => {
    await mountThenFailRefresh(() => json(502, {}))
    await screen.findByText("HTTP 502")
  })

  it("fires on a period change too, not only a collection change", async () => {
    window.localStorage.setItem("rpc_admin_token", "t")
    render(<FlowtyAnalyticsClient />)
    await screen.findByText("Sales Volume")
    fetchMock.mockResolvedValue(json(503, {}))
    fireEvent.click(screen.getByRole("button", { name: "Daily" }))
    const notice = await screen.findByTestId("stale-filter-notice")
    expect(notice.textContent).toMatch(/All · monthly/)
  })

  it("does NOT fire when the refresh succeeds — an honest match must stay quiet", async () => {
    window.localStorage.setItem("rpc_admin_token", "t")
    render(<FlowtyAnalyticsClient />)
    await screen.findByText("Sales Volume")
    fetchMock.mockResolvedValue(json(200, payload({ meta: { collection: "topshot", period: "monthly", start: "a", end: "b", bucket: "month" } })))
    fireEvent.click(screen.getByRole("button", { name: "Top Shot" }))
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1))
    await waitFor(() => {
      const keys = new Set(screen.getAllByTestId("series").map((n) => n.getAttribute("data-key")))
      expect(keys).toEqual(new Set(["topshot"]))
    })
    expect(screen.queryByTestId("stale-filter-notice")).toBeNull()
  })

  it("does not fire on the very first load — there is no previous filter to mislabel", async () => {
    window.localStorage.setItem("rpc_admin_token", "t")
    fetchMock.mockResolvedValue(json(503, {}))
    render(<FlowtyAnalyticsClient />)
    await screen.findByText("HTTP 503")
    expect(screen.queryByTestId("stale-filter-notice")).toBeNull()
  })

  it("a thrown refresh is reported and still marked stale", async () => {
    await mountThenFailRefresh(() => {
      throw new Error("network down")
    })
    await screen.findByText("network down")
    await screen.findByTestId("stale-filter-notice")
  })
})

// ─── Loading + request shape ─────────────────────────────────────────────────

describe("FlowtyAnalyticsClient — loading and request shape", () => {
  it("shows a loading state before the first payload lands", async () => {
    window.localStorage.setItem("rpc_admin_token", "t")
    let release: (r: Response) => void = () => {}
    fetchMock.mockImplementation(() => new Promise<Response>((res) => { release = res }))
    render(<FlowtyAnalyticsClient />)
    await screen.findByText("Loading…")
    release(json(200, payload()))
    await screen.findByText("Sales Volume")
  })

  it("puts the selected filters in the query string", async () => {
    window.localStorage.setItem("rpc_admin_token", "t")
    render(<FlowtyAnalyticsClient />)
    await screen.findByText("Sales Volume")
    fireEvent.click(screen.getByRole("button", { name: "Golazos" }))
    fireEvent.click(screen.getByRole("button", { name: "Weekly" }))
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(urls.some((u) => u.includes("collection=golazos") && u.includes("period=weekly"))).toBe(true)
    })
  })

  it("Refresh re-requests the same filters", async () => {
    window.localStorage.setItem("rpc_admin_token", "t")
    render(<FlowtyAnalyticsClient />)
    await screen.findByText("Sales Volume")
    const before = fetchMock.mock.calls.length
    fireEvent.click(screen.getByRole("button", { name: /^refresh$/i }))
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(before + 1))
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("collection=all")
  })

  it("marks the active filter pills", async () => {
    window.localStorage.setItem("rpc_admin_token", "t")
    render(<FlowtyAnalyticsClient />)
    await screen.findByText("Sales Volume")
    expect(screen.getByRole("button", { name: "All" }).className).toContain("rpc-filter-button--active")
    expect(screen.getByRole("button", { name: "Monthly" }).className).toContain("rpc-filter-button--active")
    expect(screen.getByRole("button", { name: "UFC" }).className).not.toContain("--active")
  })
})

// ─── Sections ────────────────────────────────────────────────────────────────

describe("FlowtyAnalyticsClient — sections", () => {
  async function mount(over: Record<string, unknown> = {}) {
    window.localStorage.setItem("rpc_admin_token", "t")
    fetchMock.mockResolvedValue(json(200, payload(over)))
    render(<FlowtyAnalyticsClient />)
    await screen.findByText("Sales Volume")
  }

  it("renders the four KPI tiles with formatted values", async () => {
    await mount()
    expect(screen.getByText("$1,250,000")).toBeTruthy()
    expect(screen.getByText("42,000")).toBeTruthy()
    expect(screen.getByText("$12,500")).toBeTruthy()
  })

  it("renders the loan KPI strip", async () => {
    await mount()
    expect(screen.getByText("$310,000")).toBeTruthy()
    expect(screen.getByText("Loan Volume")).toBeTruthy()
  })

  it("renders data caveats when the API supplies them", async () => {
    await mount({ dataCaveats: ["loans cold since 2026-05-11", "sales frozen"] })
    expect(screen.getByText("DATA CAVEATS")).toBeTruthy()
    expect(screen.getByText("loans cold since 2026-05-11")).toBeTruthy()
  })

  it("omits the caveats block entirely when there are none", async () => {
    await mount({ dataCaveats: [] })
    expect(screen.queryByText("DATA CAVEATS")).toBeNull()
  })

  it("shows the last-refresh stamp when the payload carries one", async () => {
    await mount()
    expect(document.body.textContent).toContain("last refresh 2026-06-01T00:00:00Z")
  })

  it("omits the stamp rather than inventing one", async () => {
    await mount({ refreshedAt: null })
    expect(document.body.textContent).not.toContain("last refresh")
  })

  it("labels participants as distinct on a daily bucket", async () => {
    await mount({ meta: { collection: "all", period: "daily", start: "a", end: "b", bucket: "day" } })
    expect(screen.getByText("Distinct Buyers")).toBeTruthy()
    expect(screen.getByText("Distinct Sellers")).toBeTruthy()
  })

  it("labels participants as an upper bound on a rolled-up bucket", async () => {
    // ⚠ Not cosmetic: summing daily distinct counts across a month double-counts
    // anyone active on two days, so the rolled-up figure is an upper bound and
    // must say so.
    await mount()
    expect(screen.getByText("Active Buyers (daily-sum upper bound)")).toBeTruthy()
  })

  it("withholds the lifetime first-timer figures rather than printing a zero", async () => {
    await mount()
    const dashes = screen.getAllByText("—")
    expect(dashes.length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText("lifetime totals coming").length).toBe(2)
  })

  it("renders the period first-timer counts", async () => {
    await mount()
    expect(screen.getByText("First-Time Buyers (period)")).toBeTruthy()
    expect(screen.getByText("First-Time Lenders (period)")).toBeTruthy()
  })

  it("pivots the sales series into one chart row per bucket", async () => {
    await mount()
    const charts = screen.getAllByTestId("chart")
    expect(charts.some((c) => c.getAttribute("data-rows") === "2")).toBe(true)
  })

  it("drives the currency tick formatter", async () => {
    await mount()
    expect(screen.getAllByTestId("ytick").some((n) => n.textContent === "$1,500")).toBe(true)
  })

  it("drives the tooltip formatters", async () => {
    await mount()
    const tips = screen.getAllByTestId("tipfmt").map((n) => n.textContent)
    expect(tips).toContain("$2,500")
    expect(tips).toContain("2,500")
  })
})

// ─── Leaderboards ────────────────────────────────────────────────────────────

describe("FlowtyAnalyticsClient — leaderboards", () => {
  async function mountBoards(boards: Record<string, unknown>) {
    window.localStorage.setItem("rpc_admin_token", "t")
    fetchMock.mockResolvedValue(json(200, payload({ leaderboards: { ...EMPTY_BOARDS, ...boards } })))
    render(<FlowtyAnalyticsClient />)
    await screen.findByText("Leaderboards")
  }

  it("says there is no data for the period when a board is genuinely empty", async () => {
    await mountBoards({})
    expect(screen.getAllByText("No data for the selected period.").length).toBe(5)
  })

  it("renders a buyer row with a truncated, linked address", async () => {
    await mountBoards({
      topBuyers: [{ rank: 1, address: "0x1234567890abcdef", volumeUsd: 8400, txCount: 12 }],
    })
    const link = screen.getByRole("link", { name: "0x1234…cdef" })
    expect(link.getAttribute("href")).toBe("https://www.flowdiver.io/account/0x1234567890abcdef")
    expect(screen.getByText("$8,400")).toBeTruthy()
  })

  it("renders an em-dash rather than a broken link when a row has no address", async () => {
    await mountBoards({ topSellers: [{ rank: 1, volumeUsd: 10, txCount: 1 }] })
    expect(screen.queryByRole("link", { name: /0x/ })).toBeNull()
  })

  it("paints a negative net position as a loss and a positive one as a gain", async () => {
    await mountBoards({
      topNetMarketplace: [
        { rank: 1, address: "0xaaaaaaaaaaaaaaaa", grossActivityUsd: 500, netPositionUsd: 120, totalTxCount: 4 },
        { rank: 2, address: "0xbbbbbbbbbbbbbbbb", grossActivityUsd: 500, netPositionUsd: -80, totalTxCount: 4 },
      ],
    })
    expect(screen.getByText("$120.00").getAttribute("style")).toContain("--rpc-success")
    expect(screen.getByText("$-80.00").getAttribute("style")).toContain("--rpc-danger")
  })

  it("does not colour a missing net position as either", async () => {
    await mountBoards({
      topNetMarketplace: [{ rank: 1, address: "0xaaaaaaaaaaaaaaaa", grossActivityUsd: 500, totalTxCount: 4 }],
    })
    const cell = screen.getAllByText("—").find((n) => (n.getAttribute("style") ?? "").includes("--rpc-text-primary"))
    expect(cell).toBeTruthy()
  })

  it("renders a lender APR as a percentage", async () => {
    await mountBoards({
      topLenders: [{ rank: 1, address: "0xcccccccccccccccc", principalFundedUsd: 4000, loansCount: 9, avgInterestRate: 0.185 }],
    })
    expect(screen.getByText("18.50%")).toBeTruthy()
  })

  it("states a borrower's repayments as a fraction of their loans", async () => {
    await mountBoards({
      topBorrowers: [{ rank: 1, address: "0xdddddddddddddddd", principalBorrowedUsd: 2000, loansCount: 10, repaidCount: 6 }],
    })
    expect(screen.getByText("6 of 10 repaid")).toBeTruthy()
  })

  it("withholds both halves of that fraction when either is missing", async () => {
    // A "0 of 10 repaid" manufactured from an absent count is a claim about a
    // named wallet's credit behaviour.
    await mountBoards({
      topBorrowers: [{ rank: 1, address: "0xdddddddddddddddd", principalBorrowedUsd: 2000, loansCount: 10 }],
    })
    expect(screen.getByText("— of 10 repaid")).toBeTruthy()
  })

  it("coerces a numeric-string cell rather than dropping it", async () => {
    await mountBoards({
      topBuyers: [{ rank: 1, address: "0x1234567890abcdef", volumeUsd: "8400", txCount: 12 }],
    })
    expect(screen.getByText("$8,400")).toBeTruthy()
  })

  it("renders every board's heading", async () => {
    await mountBoards({})
    for (const t of ["Top Buyers", "Top Sellers", "Top Net Marketplace", "Top Lenders", "Top Borrowers"]) {
      expect(screen.getByText(t)).toBeTruthy()
    }
  })
})
