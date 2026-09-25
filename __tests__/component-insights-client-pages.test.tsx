// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"

// Render coverage for the three PUBLIC /insights surfaces that are CLIENT
// `page.tsx` files (not the `*Client.tsx` convention the other boards use), so
// the component gate's `app/insights/**/*Client.tsx` glob never reached them —
// they lived under app/ measured by NEITHER coverage gate despite carrying real
// wallet-paste + fetch + row-mapping logic. The insights-gate-include-
// completeness rot-guard now forces them into the gate; these tests keep the
// numbers honest (a render-time crash in one of them fails CI instead of the
// live page).
//
// squeeze-check + tc-report are the "paste a Flow wallet" tools (form submit →
// /api/public/insights/... → summary/report render). pack-reality is a
// mount-fetch board.

import SqueezeCheckPage from "@/app/insights/squeeze-check/page"
import TcReportPage from "@/app/insights/tc-report/page"
import PackRealityPage from "@/app/insights/pack-reality/page"

const VALID_WALLET = "0xbd94cade097e50ac"

function mockFetchOnce(payload: unknown, ok = true, status = 200) {
  return vi.fn(() =>
    Promise.resolve({
      ok,
      status,
      json: async () => payload,
    } as Response),
  )
}

beforeEach(() => {
  // Both wallet-paste pages read window.location in a mount effect; keep it on a
  // param-free URL so the auto-load branch stays dormant unless a test opts in.
  window.history.replaceState({}, "", "/insights/squeeze-check")
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("SqueezeCheckPage (app/insights/squeeze-check/page.tsx)", () => {
  it("renders the hero + empty state with a sample-wallet button before any check", () => {
    vi.stubGlobal("fetch", mockFetchOnce({}))
    render(<SqueezeCheckPage />)
    expect(screen.getByText(/What's Liquid In Your Bag/i)).toBeTruthy()
    // Empty state offers the founder sample wallet; clicking fills the input.
    const sample = screen.getByText(/Founder's wallet/i)
    fireEvent.click(sample)
    const input = screen.getByLabelText("Flow wallet address") as HTMLInputElement
    expect(input.value).toBe(VALID_WALLET)
  })

  it("rejects a malformed wallet WITHOUT hitting the network", async () => {
    const fetchMock = mockFetchOnce({})
    vi.stubGlobal("fetch", fetchMock)
    render(<SqueezeCheckPage />)
    const input = screen.getByLabelText("Flow wallet address")
    fireEvent.change(input, { target: { value: "not-a-wallet" } })
    fireEvent.click(screen.getByText(/Check exposure/i))
    await waitFor(() =>
      expect(screen.getByText(/Wallet must look like a Flow address/i)).toBeTruthy(),
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("renders the bucket bars + top-squeezed table for a populated summary", async () => {
    const summary = {
      wallet: VALID_WALLET,
      collection: "nba_top_shot",
      total_moments: 100,
      total_editions: 60,
      editions_with_badge_coverage: 40,
      buckets: {
        liquid: { editions: 30, moments: 55 },
        moderate: { editions: 10, moments: 20 },
        squeezed: { editions: 12, moments: 15 },
        extreme: { editions: 8, moments: 10 },
      },
      top_squeezed: [
        {
          player_name: "Test Player",
          set_name: "Base Set",
          tier: "LEGENDARY",
          edition_key: "1:2",
          circulation: 1000,
          locked: 400,
          burned: 350,
          squeeze_pct: 75.0,
          held: 3,
        },
      ],
      computed_at: "2026-08-01T00:00:00Z",
    }
    vi.stubGlobal("fetch", mockFetchOnce({ summary }))
    render(<SqueezeCheckPage />)
    fireEvent.change(screen.getByLabelText("Flow wallet address"), {
      target: { value: VALID_WALLET },
    })
    fireEvent.click(screen.getByText(/Check exposure/i))
    await waitFor(() => expect(screen.getByText("Test Player")).toBeTruthy())
    // Bucket labels + the squeeze table both rendered from the summary.
    expect(screen.getByText(/top squeezed holdings/i)).toBeTruthy()
    expect(screen.getByText("75.0%")).toBeTruthy() // fmtPct(squeeze_pct)
    expect(screen.getAllByText("Liquid").length).toBeGreaterThan(0)
  })

  it("surfaces a server error message from a non-ok response", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({ error: "wallet not found" }, false, 404))
    render(<SqueezeCheckPage />)
    fireEvent.change(screen.getByLabelText("Flow wallet address"), {
      target: { value: VALID_WALLET },
    })
    fireEvent.click(screen.getByText(/Check exposure/i))
    await waitFor(() => expect(screen.getByText(/wallet not found/i)).toBeTruthy())
  })

  it("auto-loads a wallet supplied via ?wallet= URL param", async () => {
    window.history.replaceState({}, "", `/insights/squeeze-check?wallet=${VALID_WALLET}`)
    const fetchMock = mockFetchOnce({
      summary: {
        wallet: VALID_WALLET,
        collection: "nba_top_shot",
        total_moments: 5,
        total_editions: 5,
        editions_with_badge_coverage: 0,
        buckets: {
          liquid: { editions: 5, moments: 5 },
          moderate: { editions: 0, moments: 0 },
          squeezed: { editions: 0, moments: 0 },
          extreme: { editions: 0, moments: 0 },
        },
        top_squeezed: [], // exercises the "nothing squeezed" empty-table branch
        computed_at: "2026-08-01T00:00:00Z",
      },
    })
    vi.stubGlobal("fetch", fetchMock)
    render(<SqueezeCheckPage />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByText(/Nothing in your bag is over 0% squeezed/i)).toBeTruthy(),
    )
  })
})

describe("TcReportPage (app/insights/tc-report/page.tsx)", () => {
  it("renders the hero + form before any report", () => {
    vi.stubGlobal("fetch", mockFetchOnce({}))
    render(<TcReportPage />)
    expect(screen.getByText(/Top Collector Report/i)).toBeTruthy()
    expect(screen.getByText(/Run report/i)).toBeTruthy()
  })

  it("rejects a malformed wallet without a network call", async () => {
    const fetchMock = mockFetchOnce({})
    vi.stubGlobal("fetch", fetchMock)
    render(<TcReportPage />)
    fireEvent.change(screen.getByLabelText("Flow wallet address"), {
      target: { value: "0xnope" },
    })
    fireEvent.click(screen.getByText(/Run report/i))
    await waitFor(() =>
      expect(screen.getByText(/Wallet must look like a Flow address/i)).toBeTruthy(),
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("renders the full report — squeeze, cross-collection, top sets, cohorts, acquisitions", async () => {
    const report = {
      wallet: VALID_WALLET,
      computed_at: "2026-08-01T00:00:00Z",
      squeeze: {
        wallet: VALID_WALLET,
        collection: "nba_top_shot",
        total_moments: 200,
        total_editions: 120,
        editions_with_badge_coverage: 80,
        buckets: {
          liquid: { editions: 60, moments: 120 },
          moderate: { editions: 20, moments: 40 },
          squeezed: { editions: 25, moments: 25 },
          extreme: { editions: 15, moments: 15 },
        },
        top_squeezed: [
          {
            player_name: "Squeeze Star",
            set_name: "Metallic Gold LE",
            tier: "RARE",
            edition_key: "9:9",
            circulation: 499,
            locked: 200,
            burned: 150,
            squeeze_pct: 70.1,
            held: 2,
          },
        ],
        computed_at: "2026-08-01T00:00:00Z",
      },
      top_sets: [
        {
          set_name: "Base Set S4",
          series: 5,
          series_label: "Series 4",
          owned_eds: 12,
          set_total_eds: 50,
          completion_pct: 24,
          total_moments_held: 30,
        },
      ],
      wnba_coverage: {
        per_set: [{ set_name: "WNBA Origins", owned: 3, total: 10 }],
        sets_total: 4,
        sets_touched: 2,
        editions_owned: 8,
        editions_in_cohort_total: 40,
      },
      rookie_coverage: {
        cohort_size: 60,
        owned_count: 9,
        // 2026-09-24: the RPC shape — a single best MOMENT, never an edition_count.
        best_holding: { player_name: "Rook One", set_name: "Rookie Debut", tier: "RARE", serial: 1 },
      },
      cross_collection: [
        { slug: "nba_top_shot", moments: 200, editions: 120, approx_fmv_usd: 5400 },
        { slug: "nfl_all_day", moments: 30, editions: 25, approx_fmv_usd: null },
        // A CLOSED market (UFC Strike's Flow marketplace, last sale 13 May 2026)
        // still carries the last FMV the pipeline observed.
        { slug: "ufc_strike", moments: 4, editions: 4, approx_fmv_usd: 12.5 },
        // A registry collection the old hardcoded label map did not know.
        { slug: "candy_mlb", moments: 338, editions: 300, approx_fmv_usd: 900 },
      ],
      recent_acquisitions: [
        {
          edition_id: "e1",
          player_name: "Recent Buy",
          set_name: "Set X",
          tier: "COMMON",
          price_usd: 42.5,
          sold_at: "2026-07-30T00:00:00Z",
        },
      ],
    }
    vi.stubGlobal("fetch", mockFetchOnce({ report }))
    render(<TcReportPage />)
    fireEvent.change(screen.getByLabelText("Flow wallet address"), {
      target: { value: VALID_WALLET },
    })
    fireEvent.click(screen.getByText(/Run report/i))
    await waitFor(() => expect(screen.getByText("Squeeze Star")).toBeTruthy())
    expect(screen.getAllByText(/Squeeze Exposure/i).length).toBeGreaterThan(0)
    expect(screen.getByText("Base Set S4")).toBeTruthy()
    // 2026-09-24: the set's series renders beside it (four "Base Set" rows are
    // otherwise indistinguishable) and the link opens the set page, not the
    // generic squeeze board.
    expect(screen.getByText("Series 4")).toBeTruthy()
    expect(screen.getByText("Base Set S4").closest("a")?.getAttribute("href")).toBe("/nba-top-shot/set/base-set-s4")
    // The best rookie holding prints the moment the RPC returns — never a
    // fabricated "(— editions)" from a field the RPC does not carry.
    expect(screen.getByText(/Best rookie holding: Rook One/)).toBeTruthy()
    expect(screen.queryByText(/— editions/)).toBeNull()
    expect(screen.getByText("Recent Buy")).toBeTruthy()
    // Cross-collection labels come from the registry, not a hand map.
    expect(screen.getAllByText(/NFL All Day/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Candy MLB/i).length).toBeGreaterThan(0)
    expect(screen.queryByText("candy_mlb")).toBeNull()
    // 2026-09-24: an FMV on a CLOSED market is historical and says so; a live
    // market's FMV carries no such marker.
    const ufcCard = screen.getByText("UFC Strike").closest(".rpc-tc-cc-card")!
    expect(ufcCard.textContent).toMatch(/as of 13 May 2026 · Flow market closed/)
    const tsCard = screen.getByText("NBA Top Shot").closest(".rpc-tc-cc-card")!
    expect(tsCard.textContent).toContain("FMV")
    expect(tsCard.textContent).not.toMatch(/market closed/)
  })
})

describe("PackRealityPage (app/insights/pack-reality/page.tsx)", () => {
  it("shows the loading state then renders KPIs + distribution + ranker on mount fetch", async () => {
    const payload = {
      meta: { fetched_at: "2026-08-01T00:00:00Z" },
      stats: {
        rips_60d: 145000,
        zero_value_rips: 60000,
        zero_value_pct: 41.2,
        mean_pull_value_usd: 5.86,
        median_pull_value_usd: 1.5,
        p90_pull_value_usd: 20,
        p99_pull_value_usd: 120,
        rips_over_100: 1400,
        rips_over_100_pct: 0.97,
        rips_over_1000: 42,
      },
      distribution: [
        { bucket: "$0", rips: 60000, pct: 41.2 },
        { bucket: "$0–5", rips: 40000, pct: 27.5 },
      ],
      top_ev: [
        {
          pack_listing_id: "p1",
          dist_id: "d1",
          pack_name: "Test Pack",
          pack_price: 9,
          gross_ev: 14,
          pack_ev: 5,
          value_ratio: 1.6,
          fmv_coverage_pct: 90,
          edition_count: 20,
          total_unopened: 500,
          depletion_pct: 40,
          snapshotted_at: "2026-08-01T00:00:00Z",
          price_source: "primary",
          high_variance: false,
          is_reward_pack: false,
          retail_price_usd_normalized: 9,
        },
      ],
    }
    vi.stubGlobal("fetch", mockFetchOnce(payload))
    render(<PackRealityPage />)
    expect(screen.getByText("Pack Reality")).toBeTruthy()
    await waitFor(() => expect(screen.getByText("Test Pack")).toBeTruthy())
    // KPI strip formatted the headline stats.
    expect(screen.getByText(/Rips \(60d\)/i)).toBeTruthy()
    expect(screen.getByText("$0")).toBeTruthy() // distribution bucket label
  })

  it("renders the failed-to-load state on a non-ok fetch", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({}, false, 500))
    render(<PackRealityPage />)
    await waitFor(() => expect(screen.getByText(/Failed to load/i)).toBeTruthy())
  })
})
