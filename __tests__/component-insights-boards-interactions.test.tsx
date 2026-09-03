// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"

// Interaction coverage for the /insights boards whose window/sort CONTROLS were
// dark after the populated-row pass (that pass only rendered the default view).
// - MarketPulse: the 24h/7d/30d window toggle is a PURE client re-sort (pick()
//   has a distinct branch per window; only 7d carries sellers), no network.
// - Rookies / AllDayScarcity / SetSqueeze: changing the sort re-runs the fetch
//   effect (skip-first-run guard means the default view came from initialRows);
//   driving it exercises the effect's success leg (loading -> setRows/setData).

import MarketPulseClient from "@/app/insights/market-pulse/MarketPulseClient"
import RookiesBoardClient from "@/app/insights/rookies/RookiesBoardClient"
import AllDayScarcityBoardClient from "@/app/insights/allday-scarcity/AllDayScarcityBoardClient"
import SetSqueezeBoardClient from "@/app/insights/set-squeeze/SetSqueezeBoardClient"
import CrossCollectionBoardClient from "@/app/insights/cross-collection/CrossCollectionBoardClient"

const FETCHED = "2026-07-31T00:00:00Z"

const marketPulseRow = {
  slug: "nba_top_shot",
  collection_name: "NBA Top Shot Pulse",
  sales_24h: 120, volume_24h: 45000, buyers_24h: 88, top_sale_24h: 5000,
  sales_7d: 900, volume_7d: 320000, buyers_7d: 410, sellers_7d: 380, top_sale_7d: 12000,
  sales_30d: 3800, volume_30d: 1400000, buyers_30d: 1600, top_sale_30d: 25000,
}

const rookiesInitial = {
  meta: { fetched_at: FETCHED },
  cohort_stats: {
    rookie_count: 40, total_sales_30d: 900, total_gmv_30d: 250000, avg_price_active: 180,
    rookies_with_activity_30d: 32, rookies_with_mint_one_sale: 8, top_mint_one_sale: 12000,
  },
  rows: [
    {
      player_name: "Zaccharie Risacher", edition_count: 6, sales_30d: 120, gmv_30d: 30000,
      avg_price_30d: 250, max_sale_30d: 3000, total_locked: 5000, total_burned: 400,
      total_circ: 12000, cohort_squeeze_pct: 45, avg_lock_rate_pct: 41,
      mint_one_eds_with_history: 2, max_mint_one_sale_usd: 4000,
    },
  ],
}

const alldayScarcityRow = {
  external_id: "ad-1", player_name: "Patrick Mahomes", set_name: "Base Set", tier: "LEGENDARY",
  team_name: "Kansas City Chiefs", series: 4, mint_count: 99, family_avg_mint: 500, family_size: 12,
  scarcity_vs_family_pct: 80.2, fmv_usd: 1250, fmv_confidence: "HIGH", thumbnail_url: "https://example.com/a.png",
}

const setSqueezeRow = {
  set_id: "s1", set_name: "Metallic Gold Squeeze Set", series: 4, set_tier: "LEGENDARY",
  editions_covered: 20, avg_squeeze_pct: 45.2, median_squeeze_pct: 44.1, max_squeeze_pct: 71.5,
  min_squeeze_pct: 12.3, total_circ: 40000, total_locked: 18000, total_burned: 2000,
  total_buyable: 20000, avg_fmv_usd: 250, fmv_covered_editions: 18,
}

beforeEach(() => {
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: false, media: q, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("insights boards — interaction coverage", () => {
  it("MarketPulseClient re-sorts across all three windows (pure client)", () => {
    const { getByText, getAllByText } = render(
      <MarketPulseClient initialRows={[marketPulseRow]} fetchedAt={FETCHED} />,
    )
    // default 7d renders sellers; switching windows exercises pick()'s branches
    for (const label of ["24h", "30d", "7d"]) {
      fireEvent.click(getByText(label))
      expect(getAllByText(/NBA Top Shot Pulse/).length).toBeGreaterThan(0)
    }
  })

  it("RookiesBoardClient refetches on a sort-pill change", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (String(url).includes("/api/profile/me")) return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      return Promise.resolve({ ok: true, json: async () => rookiesInitial } as Response)
    }))
    const { getByText, getAllByText } = render(<RookiesBoardClient initial={rookiesInitial} />)
    fireEvent.click(getByText("Lock rate"))
    await waitFor(() => expect((globalThis.fetch as any).mock.calls.some((c: any[]) => String(c[0]).includes("sort=lock"))).toBe(true))
    // The refetch resolving and re-rendering happens AFTER the call the line above
    // waited for — asserting synchronously here read "Loading…" on a loaded CI runner
    // (2026-09-03, 1 of ~40 runs). Wait for the render, not the call.
    await waitFor(() => expect(getAllByText(/Zaccharie Risacher/).length).toBeGreaterThan(0))
  })

  it("AllDayScarcityBoardClient refetches on a sort change", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (String(url).includes("/api/profile/me")) return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      return Promise.resolve({ ok: true, json: async () => ({ rows: [alldayScarcityRow], meta: { fetched_at: FETCHED, total_rows: 1 } }) } as Response)
    }))
    const { container, getAllByText } = render(
      <AllDayScarcityBoardClient initialRows={[alldayScarcityRow]} initialFetchedAt={FETCHED} />,
    )
    const select = container.querySelector("select")!
    fireEvent.change(select, { target: { value: "mint" } })
    await waitFor(() => expect((globalThis.fetch as any).mock.calls.some((c: any[]) => String(c[0]).includes("allday-scarcity"))).toBe(true))
    await waitFor(() => expect(getAllByText(/Patrick Mahomes/).length).toBeGreaterThan(0))
  })

  it("SetSqueezeBoardClient refetches on a sort change", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (String(url).includes("/api/profile/me")) return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      return Promise.resolve({ ok: true, json: async () => ({ rows: [setSqueezeRow], meta: { fetched_at: FETCHED, total_rows: 1 } }) } as Response)
    }))
    const { container, getAllByText } = render(
      <SetSqueezeBoardClient initialRows={[setSqueezeRow]} initialFetchedAt={FETCHED} />,
    )
    const select = container.querySelector("select")!
    fireEvent.change(select, { target: { value: "buyable" } })
    await waitFor(() => expect((globalThis.fetch as any).mock.calls.some((c: any[]) => String(c[0]).includes("set-squeeze"))).toBe(true))
    await waitFor(() => expect(getAllByText(/Metallic Gold Squeeze Set/).length).toBeGreaterThan(0))
  })

  // AllDayScarcity: the sort refetch was covered above; the TIER pill (which sets
  // the tier= param), the error state, the empty state, and the ASK_ONLY fmv-basis
  // marker / null-value cells were still dark.
  it("AllDayScarcityBoardClient refetches with the tier param when a tier pill is clicked", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (String(url).includes("/api/profile/me")) return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      return Promise.resolve({ ok: true, json: async () => ({ rows: [alldayScarcityRow], meta: { fetched_at: FETCHED, total_rows: 1 } }) } as Response)
    }))
    const { container } = render(
      <AllDayScarcityBoardClient initialRows={[alldayScarcityRow]} initialFetchedAt={FETCHED} />,
    )
    const pill = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "LEGENDARY")!
    expect(pill).toBeTruthy()
    fireEvent.click(pill)
    await waitFor(() =>
      expect((globalThis.fetch as any).mock.calls.some((c: any[]) => String(c[0]).includes("allday-scarcity") && String(c[0]).includes("tier=LEGENDARY"))).toBe(true),
    )
  })

  it("AllDayScarcityBoardClient shows the error state on a failed refetch", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (String(url).includes("/api/profile/me")) return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      return Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response)
    }))
    const { container } = render(
      <AllDayScarcityBoardClient initialRows={[alldayScarcityRow]} initialFetchedAt={FETCHED} />,
    )
    fireEvent.change(container.querySelector("select")!, { target: { value: "fmv" } })
    await waitFor(() => expect(container.textContent).toMatch(/Failed to load|HTTP 500/i))
  })

  it("AllDayScarcityBoardClient renders the empty state with no rows", () => {
    const { container } = render(
      <AllDayScarcityBoardClient initialRows={[]} initialFetchedAt={FETCHED} />,
    )
    expect(container.textContent).toMatch(/No editions match those filters/i)
  })

  it("AllDayScarcityBoardClient marks an ASK_ONLY row 'from asks' and em-dashes null cells", () => {
    const askOnlyRow = {
      ...alldayScarcityRow,
      external_id: "ad-2",
      player_name: "Justin Jefferson",
      fmv_usd: 42,
      fmv_confidence: "ASK_ONLY",
      family_avg_mint: null,
    }
    const { container } = render(
      <AllDayScarcityBoardClient initialRows={[askOnlyRow]} initialFetchedAt={FETCHED} />,
    )
    // fmvBasis(ASK_ONLY) -> the "from asks" plain-English marker
    expect(container.textContent).toContain("from asks")
    // family_avg_mint null -> the "—" fallback in that cell
    expect(container.textContent).toContain("—")
  })
})

// CrossCollectionBoardClient: the sort-refetch useEffect body (loading → setData
// → error), the sort pill onClick, the hasTs-false Flowscan link branch, the
// null overlap set_name cell, and the empty wallet/overlap states were all dark.
const ccInitial = {
  meta: { fetched_at: FETCHED },
  stats: {
    cohort_size: 500, three_coll_wallets: 200, four_coll_wallets: 100,
    five_plus_coll_wallets: 40, cohort_total_moments: 120000,
    avg_moments_per_wallet: 240, median_moments_per_wallet: 180, cohort_total_fmv_usd: 4500000,
  },
  wallets: [
    // hasTs=true -> squeeze-check internal link
    { wallet_address: "0xabcdef0123456789", n_collections: 5, total_moments: 800, ts_moments: 400, allday_moments: 200, golazos_moments: 100, pinnacle_moments: 60, ufc_moments: 40, approx_fmv_usd: 90000 },
    // hasTs=false (ts_moments 0) -> Flowscan external link; also a short (<=14) addr
    { wallet_address: "0xshort", n_collections: 3, total_moments: 30, ts_moments: 0, allday_moments: 10, golazos_moments: 10, pinnacle_moments: 10, ufc_moments: 0, approx_fmv_usd: null },
  ],
  ts_set_overlap: [
    { set_id: "s1", set_name: "Cosmic Overlap Set", cohort_holders: 300, moments_in_cohort: 1200 },
    // null set_name -> the "—" fallback cell
    { set_id: "s2", set_name: null, cohort_holders: 12, moments_in_cohort: 40 },
  ],
}

describe("CrossCollectionBoardClient — interaction coverage", () => {
  it("routes a no-TS wallet to Flowscan and a TS wallet to squeeze-check", () => {
    const { container } = render(<CrossCollectionBoardClient initial={ccInitial as any} />)
    // hasTs=true wallet -> internal squeeze-check link
    expect(container.querySelector('a[href^="/insights/squeeze-check?wallet="]')).toBeTruthy()
    // hasTs=false wallet -> external Flowscan link opened in a new tab
    const flowscan = container.querySelector('a[href^="https://www.flowscan.io/account/"]') as HTMLAnchorElement
    expect(flowscan).toBeTruthy()
    expect(flowscan.getAttribute("target")).toBe("_blank")
    // null overlap set_name renders the em-dash fallback
    expect(container.textContent).toContain("—")
  })

  it("refetches with the new sort key when a sort pill is clicked", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (String(url).includes("/api/profile/me")) return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      return Promise.resolve({
        ok: true,
        json: async () => ({
          ...ccInitial,
          wallets: [{ ...ccInitial.wallets[0], wallet_address: "0xreSortedWallet00", approx_fmv_usd: 111111 }],
        }),
      } as Response)
    }))
    const { container } = render(<CrossCollectionBoardClient initial={ccInitial as any} />)
    const fmvPill = [...container.querySelectorAll("button.rpc-cc-pill")].find((b) => (b.textContent ?? "").trim() === "Approx FMV")!
    fireEvent.click(fmvPill)
    await waitFor(() =>
      expect((globalThis.fetch as any).mock.calls.some((c: any[]) => String(c[0]).includes("cross-collection") && String(c[0]).includes("sort=fmv"))).toBe(true),
    )
    // the refetched wallet's FMV (fmtUsd(111111) -> "$111k") replaces the initial view
    await waitFor(() => expect(container.textContent).toContain("$111k"))
  })

  it("surfaces the error state when a sort refetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (String(url).includes("/api/profile/me")) return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      return Promise.resolve({ ok: false, status: 503, json: async () => ({}) } as Response)
    }))
    const { container } = render(<CrossCollectionBoardClient initial={ccInitial as any} />)
    const nCollPill = [...container.querySelectorAll("button.rpc-cc-pill")].find((b) => (b.textContent ?? "").trim() === "# collections")!
    fireEvent.click(nCollPill)
    await waitFor(() => expect(container.textContent).toMatch(/Failed to load|HTTP 503/i))
  })

  it("renders the empty wallet + overlap states when the cohort is empty", () => {
    const empty = { ...ccInitial, wallets: [], ts_set_overlap: [] }
    const { container } = render(<CrossCollectionBoardClient initial={empty as any} />)
    expect(container.textContent).toMatch(/No wallets found/i)
    expect(container.textContent).toMatch(/No overlap data/i)
  })
})
