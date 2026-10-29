// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"

// /insights/tc-report (2026-10-28): the NFL All Day squeeze section, and the three states behind an empty report.
// A report built from zero cache rows must never render as a reading — "— moments across", "No rookie editions
// held", "0 of 17 WNBA sets" — for a wallet we never scanned.

import TcReportPage from "@/app/insights/tc-report/page"

const W = "0xbd94cade097e50ac"

const zeroReport = {
  wallet: W,
  computed_at: "2026-10-28T00:00:00Z",
  squeeze: { wallet: W, collection: "nba_top_shot", total_moments: null, total_editions: 0, editions_with_badge_coverage: 0, buckets: null, top_squeezed: [], computed_at: "" },
  top_sets: [],
  wnba_coverage: { per_set: [], series: 8, series_label: "Series 2025-26", sets_total: 17, sets_touched: 0, editions_owned: 0, editions_in_cohort_total: 1038 },
  rookie_coverage: { cohort_size: 61, owned_count: 0, best_holding: null },
  cross_collection: [],
  recent_acquisitions: [],
}

function squeeze(collection: string, player: string, total = 10) {
  return {
    wallet: W,
    collection,
    total_moments: total,
    total_editions: 4,
    editions_with_badge_coverage: 4,
    buckets: {
      liquid: { editions: 2, moments: 5 },
      moderate: { editions: 1, moments: 2 },
      squeezed: { editions: 1, moments: 3 },
      extreme: { editions: 0, moments: 0 },
    },
    top_squeezed: [
      { player_name: player, set_name: "Base", tier: "UNCOMMON", edition_key: `${collection}:1`, circulation: 100, locked: 40, burned: 20, squeeze_pct: 60, held: 3 },
    ],
    computed_at: "",
  }
}

type Reply = { status?: number; body: unknown }
let routes: Record<string, () => Reply>
let calls: string[]

function install() {
  calls = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      calls.push(init?.method === "POST" ? `POST ${u}` : u)
      const key = Object.keys(routes).find((k) => u.includes(k))
      const r = key ? routes[key]() : { status: 404, body: {} }
      const status = r.status ?? 200
      return { ok: status >= 200 && status < 300, status, json: async () => r.body } as Response
    }),
  )
}

beforeEach(() => {
  window.history.replaceState({}, "", "/insights/tc-report")
  routes = {}
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function run() {
  fireEvent.change(screen.getByLabelText("Flow wallet address"), { target: { value: W } })
  fireEvent.click(screen.getByText(/Run report/i))
}

describe("Top Collector Report — index state", () => {
  it("a never-scanned wallet is queued — no zeroed report, no 'No rookie editions held'", async () => {
    routes = {
      "/api/public/insights/tc-report": () => ({ body: { index_state: "not_indexed", report: zeroReport, allday_squeeze: null, allday_squeeze_error: false } }),
      "/api/public/queue-wallet": () => ({ status: 202, body: { queued: true } }),
    }
    install()
    render(<TcReportPage />)
    await run()
    await waitFor(() => expect(screen.getByTestId("tc-not-indexed")).toBeTruthy())
    expect(screen.queryByText(/No rookie editions held/)).toBeNull()
    expect(screen.queryByText(/moments across/)).toBeNull()
    expect(screen.queryByText(/WNBA Sets/)).toBeNull()
    await waitFor(() => expect(calls.some((c) => c.startsWith("POST /api/public/queue-wallet"))).toBe(true))
    await waitFor(() => expect(screen.getByText(/Indexing has started/)).toBeTruthy())
  })

  it("Check again re-reads and replaces the not-indexed state with the report", async () => {
    let indexed = false
    routes = {
      "/api/public/insights/tc-report": () =>
        indexed
          ? { body: { index_state: "indexed", report: { ...zeroReport, squeeze: squeeze("nba_top_shot", "TS Star"), cross_collection: [{ slug: "nba_top_shot", moments: 10, editions: 4, approx_fmv_usd: 50 }] }, allday_squeeze: null, allday_squeeze_error: false } }
          : { body: { index_state: "not_indexed", report: zeroReport, allday_squeeze: null, allday_squeeze_error: false } },
      "/api/public/queue-wallet": () => ({ status: 202, body: { queued: true } }),
    }
    install()
    render(<TcReportPage />)
    await run()
    await waitFor(() => expect(screen.getByTestId("tc-recheck")).toBeTruthy())
    indexed = true
    fireEvent.click(screen.getByTestId("tc-recheck"))
    await waitFor(() => expect(screen.getByText("TS Star")).toBeTruthy())
    expect(screen.queryByTestId("tc-not-indexed")).toBeNull()
  })

  it("a refused queue says indexing did not start", async () => {
    routes = {
      "/api/public/insights/tc-report": () => ({ body: { index_state: "not_indexed", report: zeroReport } }),
      "/api/public/queue-wallet": () => ({ status: 429, body: { queued: false } }),
    }
    install()
    render(<TcReportPage />)
    await run()
    await waitFor(() => expect(screen.getByText(/couldn't start indexing just now/)).toBeTruthy())
    expect(screen.queryByText(/Indexing has started/)).toBeNull()
  })

  it("a scanned-empty wallet says what our scan found, with its date — never a zeroed report", async () => {
    routes = {
      "/api/public/insights/tc-report": () => ({ body: { index_state: "empty", last_scanned_at: "2026-10-28T09:00:00Z", report: zeroReport } }),
    }
    install()
    render(<TcReportPage />)
    await run()
    await waitFor(() => expect(screen.getByTestId("tc-empty")).toBeTruthy())
    expect(screen.getByText(/found no moments/)).toBeTruthy()
    expect(screen.getByText(/Oct 28, 2026/)).toBeTruthy()
    expect(screen.queryByText(/No rookie editions held/)).toBeNull()
    expect(calls.some((c) => c.startsWith("POST /api/public/queue-wallet"))).toBe(false)
  })

  it("an answer with no index_state is unknown — never rendered as a reading", async () => {
    routes = { "/api/public/insights/tc-report": () => ({ body: { report: zeroReport } }) }
    install()
    render(<TcReportPage />)
    await run()
    await waitFor(() => expect(screen.getByTestId("tc-unknown")).toBeTruthy())
    expect(screen.queryByText(/No rookie editions held/)).toBeNull()
  })
})

describe("Top Collector Report — NFL All Day squeeze", () => {
  const indexedReport = { ...zeroReport, squeeze: squeeze("nba_top_shot", "TS Star"), cross_collection: [{ slug: "nba_top_shot", moments: 10, editions: 4, approx_fmv_usd: 50 }] }

  it("renders the All Day section beside Top Shot's when the leg found moments", async () => {
    routes = {
      "/api/public/insights/tc-report": () => ({ body: { index_state: "indexed", report: indexedReport, allday_squeeze: { index_state: "indexed", summary: squeeze("nfl_all_day", "AD Star", 7) }, allday_squeeze_error: false } }),
    }
    install()
    render(<TcReportPage />)
    await run()
    await waitFor(() => expect(screen.getByText("AD Star")).toBeTruthy())
    const ad = screen.getByTestId("tc-squeeze-allday")
    expect(ad.textContent).toContain("NFL All Day moments across")
    expect(ad.textContent).not.toContain("TS Star")
    expect(screen.getByTestId("tc-squeeze-topshot").textContent).toContain("TS Star")
  })

  it("a failed All Day leg says so in its own section; the rest of the report stands", async () => {
    routes = {
      "/api/public/insights/tc-report": () => ({ body: { index_state: "indexed", report: indexedReport, allday_squeeze: null, allday_squeeze_error: true } }),
    }
    install()
    render(<TcReportPage />)
    await run()
    await waitFor(() => expect(screen.getByTestId("tc-squeeze-allday-error")).toBeTruthy())
    expect(screen.getByText("TS Star")).toBeTruthy()
  })

  it("no All Day bag → no All Day section; a Top Shot leg with no moments says so instead of 0% bars", async () => {
    routes = {
      "/api/public/insights/tc-report": () => ({ body: { index_state: "indexed", report: { ...zeroReport, cross_collection: [{ slug: "nfl_all_day", moments: 3, editions: 3, approx_fmv_usd: 1 }] }, allday_squeeze: { index_state: "not_indexed", summary: { total_moments: null } }, allday_squeeze_error: false } }),
    }
    install()
    render(<TcReportPage />)
    await run()
    await waitFor(() => expect(screen.getByTestId("tc-squeeze-topshot")).toBeTruthy())
    expect(screen.queryByTestId("tc-squeeze-allday")).toBeNull()
    expect(screen.getByText(/No Top Shot moments in our index for this wallet/)).toBeTruthy()
    expect(screen.queryByLabelText("Exposure buckets")).toBeNull()
  })

  // 10-28 review: every non-indexed All Day leg state rendered NOTHING, so a failed state read looked like "no All
  // Day squeeze". Each now says what we know; none renders bars.
  it.each([
    ["empty", /Our last scan found no NFL All Day moments/],
    ["not_indexed", /haven't indexed this wallet's NFL All Day moments yet/],
    ["unknown", /couldn't confirm whether this wallet's NFL All Day moments are indexed/],
    [null, /couldn't confirm whether this wallet's NFL All Day moments are indexed/],
  ])("an All Day leg in state %s says so in its own section, never a silent absence", async (state, copy) => {
    routes = {
      "/api/public/insights/tc-report": () => ({ body: { index_state: "indexed", report: indexedReport, allday_squeeze: state === null ? null : { index_state: state, summary: { total_moments: null } }, allday_squeeze_error: false } }),
    }
    install()
    render(<TcReportPage />)
    await run()
    await waitFor(() => expect(screen.getByTestId("tc-squeeze-allday-state")).toBeTruthy())
    expect(screen.getByTestId("tc-squeeze-allday-state").textContent).toMatch(copy as RegExp)
    expect(screen.queryByTestId("tc-squeeze-allday")).toBeNull()
    expect(screen.getByText("TS Star")).toBeTruthy()
  })
})
