// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

// Populated-row tests for the second tranche of smoke-only /insights boards —
// the ones the board-clients smoke sweep only renders with ZERO rows (empty
// branch). Each test here renders ONE representative row/board so the per-row
// cell mapping + money/count/percent formatters (the largest previously-dark
// chunk of each client) actually execute. These were the lowest-coverage
// insights clients (MarketPulse 21%, PackDrops 30%, AllDayScarcity 37%,
// SetSqueeze 39%, NewCollectors 42%, SetCompleters 43%, CrossCollection 44%,
// PackSniper 47%, Rookies 48%). Anchor = a distinctive display string per board.

import AllDayScarcityBoardClient from "@/app/insights/allday-scarcity/AllDayScarcityBoardClient"
import CrossCollectionBoardClient from "@/app/insights/cross-collection/CrossCollectionBoardClient"
import MarketPulseClient from "@/app/insights/market-pulse/MarketPulseClient"
import NewCollectorsBoardClient from "@/app/insights/new-collectors/NewCollectorsBoardClient"
import PackDropsBoardClient from "@/app/insights/pack-drops/PackDropsBoardClient"
import PackSniperClient from "@/app/insights/pack-sniper/PackSniperClient"
import RookiesBoardClient from "@/app/insights/rookies/RookiesBoardClient"
import SetCompletersBoardClient from "@/app/insights/set-completers/SetCompletersBoardClient"
import SetSqueezeBoardClient from "@/app/insights/set-squeeze/SetSqueezeBoardClient"

const FETCHED = "2026-07-31T00:00:00Z"

const alldayScarcityRow = {
  external_id: "ad-1",
  player_name: "Patrick Mahomes",
  set_name: "Base Set",
  tier: "LEGENDARY",
  team_name: "Kansas City Chiefs",
  series: 4,
  mint_count: 99,
  family_avg_mint: 500,
  family_size: 12,
  scarcity_vs_family_pct: 80.2,
  fmv_usd: 1250,
  fmv_confidence: "HIGH",
  thumbnail_url: "https://example.com/a.png",
}

const setSqueezeRow = {
  set_id: "s1",
  set_name: "Metallic Gold Squeeze Set",
  series: 4,
  set_tier: "LEGENDARY",
  editions_covered: 20,
  avg_squeeze_pct: 45.2,
  median_squeeze_pct: 44.1,
  max_squeeze_pct: 71.5,
  min_squeeze_pct: 12.3,
  total_circ: 40000,
  total_locked: 18000,
  total_burned: 2000,
  total_buyable: 20000,
  avg_fmv_usd: 250,
  fmv_covered_editions: 18,
}

const marketPulseRow = {
  slug: "nba_top_shot",
  collection_name: "NBA Top Shot Pulse",
  sales_24h: 120,
  volume_24h: 45000,
  buyers_24h: 88,
  top_sale_24h: 5000,
  sales_7d: 900,
  volume_7d: 320000,
  buyers_7d: 410,
  sellers_7d: 380,
  top_sale_7d: 12000,
  sales_30d: 3800,
  volume_30d: 1400000,
  buyers_30d: 1600,
  top_sale_30d: 25000,
}

const packDrop = {
  drop_id: 1,
  name: "Series 8 Premium Pack",
  description: "A test drop",
  status: "active",
  pack_count: 10000,
  opened_count: 4000,
  nfts_per_pack: 5,
  total_nfts: 50000,
  listing_price_flow: 250,
  listing_currency: "FLOW",
  pack_price_flow: 25,
  pack_price_usd: 20,
  flow_usd: 0.8,
  rpc_pool_usd: 1200,
  rpc_pack_ev_usd: 30,
  value_concentration_pct: 42,
  matched_count: 8,
  total_distinct: 10,
  has_parallel: false,
  verdict: "Value",
  verdict_kind: "value" as const,
  sale_state: null,
  odds: null,
  rows: [
    {
      player: "Ja Morant",
      set: "Base Set",
      series: 4,
      count: 2,
      value_tier: "Chase",
      their_est: 100,
      rpc_fmv_avg: 120,
      confidence: "HIGH",
      edition_matches: 1,
      matched: true,
      is_parallel: false,
      pool_contribution: 240,
      used_fallback: false,
    },
  ],
}

const packSniperDeal = {
  distId: "d1",
  title: "Rare Rip City Pack",
  tier: "rare",
  imageUrl: "https://example.com/p.png",
  slots: 5,
  lowestAsk: 40,
  grossEV: 62,
  liveValueRatio: 1.55,
  discountPct: 22,
  fmvCoveragePct: 90,
  evSnapshottedAt: FETCHED,
  editionCount: 12,
  depletionPct: 30,
  highVariance: false,
  highVarianceReasons: [],
  buyUrl: "https://example.com/buy",
  dapperUrl: "https://example.com/dapper",
  detailHref: "/x",
  simulatorHref: "/y",
  askChangedAt: FETCHED,
  askFirstSeenAt: FETCHED,
  prevAsk: 50,
  isNew: true,
  isPriceDrop: true,
  askDropPct: 20,
  lowAsk24h: 40,
  lowAsk7d: 38,
  atLow24h: true,
}

const crossCollectionInitial = {
  meta: { fetched_at: FETCHED },
  stats: {
    cohort_size: 500,
    three_coll_wallets: 200,
    four_coll_wallets: 100,
    five_plus_coll_wallets: 40,
    cohort_total_moments: 120000,
    avg_moments_per_wallet: 240,
    median_moments_per_wallet: 180,
    cohort_total_fmv_usd: 4500000,
    // The mats' own rebuild instant, deliberately DIFFERENT from meta.fetched_at
    // (the read time): the board renders this one, and the two being distinguishable
    // is the point — see ApiResponse's note in CrossCollectionBoardClient.
    computed_at: "2026-07-30T04:10:00.000Z",
  },
  wallets: [
    {
      wallet_address: "0xabcdef0123456789",
      n_collections: 5,
      total_moments: 800,
      ts_moments: 400,
      allday_moments: 200,
      golazos_moments: 100,
      pinnacle_moments: 60,
      ufc_moments: 40,
      approx_fmv_usd: 90000,
    },
  ],
  ts_set_overlap: [
    { set_id: "s1", set_name: "Cosmic Overlap Set", cohort_holders: 300, moments_in_cohort: 1200 },
  ],
}

const newCollectorsBoard = {
  summary: [
    {
      window_label: "30d",
      days: 30,
      new_first_seen: 1200,
      new_debiased: 900,
      new_prior_period: 1000,
      active_buyers: 5000,
      returning_buyers: 3800,
      market_usd: 2000000,
      new_usd: 400000,
      median_first_buy: 25,
      avg_first_buy: 60,
      computed_at: FETCHED,
    },
  ],
  spend: [
    {
      window_label: "30d",
      b_lt5: 100,
      b_5_25: 400,
      b_25_100: 500,
      b_100_500: 150,
      b_500plus: 50,
      total_new: 1200,
    },
  ],
  gateway: {
    "30d": {
      sets: [{ window_label: "30d", kind: "set" as const, name: "Gateway Base Set", series: 4, buyers: 400, rnk: 1 }],
      players: [{ window_label: "30d", kind: "player" as const, name: "Gateway Rookie", series: null, buyers: 300, rnk: 1 }],
    },
  },
  cohorts: [
    {
      cohort_month: "2026-06",
      cohort_size: 800,
      repeat_30d_pct: 40,
      repeat_60d_pct: 30,
      repeat_90d_pct: 25,
      ltv_median: 120,
      ltv_avg: 240,
      whales: 12,
      median_days_to_10th: 14,
    },
  ],
  computed_at: FETCHED,
}

const rookiesInitial = {
  meta: { fetched_at: FETCHED },
  cohort_stats: {
    rookie_count: 40,
    total_sales_30d: 900,
    total_gmv_30d: 250000,
    avg_price_active: 180,
    rookies_with_activity_30d: 32,
    rookies_with_mint_one_sale: 8,
    top_mint_one_sale: 12000,
  },
  rows: [
    {
      player_name: "Zaccharie Risacher",
      edition_count: 6,
      sales_30d: 120,
      gmv_30d: 30000,
      avg_price_30d: 250,
      max_sale_30d: 3000,
      total_locked: 5000,
      total_burned: 400,
      total_circ: 12000,
      cohort_squeeze_pct: 45,
      avg_lock_rate_pct: 41,
      mint_one_eds_with_history: 2,
      max_mint_one_sale_usd: 4000,
    },
  ],
}

const setCompletersBoard = {
  rows: [
    {
      set_id_onchain: 141,
      set_name: "Completers Base Set 2024",
      total_plays: 100,
      completers: 25,
      holders_with_any: 500,
      completion_rate: 0.05,
    },
  ],
}

beforeEach(() => {
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: false, media: q, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia
  }
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (String(url).includes("/api/profile/me")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ rows: [], meta: { fetched_at: null, total_rows: 0, elapsed_ms: 1 } }),
      } as Response)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("insights boards — populated row render (tranche 2)", () => {
  it("AllDayScarcityBoardClient renders a scarcity row", () => {
    const { getAllByText } = render(
      <AllDayScarcityBoardClient initialRows={[alldayScarcityRow]} initialFetchedAt={FETCHED} />,
    )
    expect(getAllByText(/Patrick Mahomes/).length).toBeGreaterThan(0)
  })

  it("SetSqueezeBoardClient renders a set-squeeze row", () => {
    const { getAllByText } = render(
      <SetSqueezeBoardClient initialRows={[setSqueezeRow]} initialFetchedAt={FETCHED} />,
    )
    expect(getAllByText(/Metallic Gold Squeeze Set/).length).toBeGreaterThan(0)
  })

  it("MarketPulseClient renders a per-collection pulse card", () => {
    const { getAllByText } = render(
      <MarketPulseClient initialRows={[marketPulseRow]} fetchedAt={FETCHED} />,
    )
    expect(getAllByText(/NBA Top Shot Pulse/).length).toBeGreaterThan(0)
  })

  it("PackDropsBoardClient renders a scored drop card", () => {
    const { getAllByText } = render(
      <PackDropsBoardClient initialDrops={[packDrop]} initialFetchedAt={FETCHED} />,
    )
    expect(getAllByText(/Series 8 Premium Pack/).length).toBeGreaterThan(0)
  })

  it("PackSniperClient renders a ranked pack deal", async () => {
    // PackSniper refetches on mount (client defaults showHighVariance=true,
    // which differs from the server-rendered "hidden" default), so initialDeals
    // is replaced by the fetch result — serve the deal from the endpoint too.
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (String(url).includes("/api/profile/me")) {
          return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
        }
        if (String(url).includes("pack-sniper")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ deals: [packSniperDeal], meta: { fetched_at: FETCHED, collection: "nba-top-shot" } }),
          } as Response)
        }
        return Promise.resolve({ ok: true, json: async () => ({ deals: [], meta: { fetched_at: null } }) } as Response)
      }),
    )
    const { findAllByText } = render(
      <PackSniperClient initialDeals={[packSniperDeal]} initialFetchedAt={FETCHED} lockedCollection={undefined} />,
    )
    expect((await findAllByText(/Rare Rip City Pack/)).length).toBeGreaterThan(0)
  })

  it("CrossCollectionBoardClient renders the cohort + set-overlap tables", () => {
    const { getAllByText } = render(
      <CrossCollectionBoardClient initial={crossCollectionInitial} />,
    )
    expect(getAllByText(/Cosmic Overlap Set/).length).toBeGreaterThan(0)
  })

  it("NewCollectorsBoardClient renders the gateway list", () => {
    const { getAllByText } = render(
      <NewCollectorsBoardClient initialBoard={newCollectorsBoard} initialFetchedAt={FETCHED} />,
    )
    expect(getAllByText(/Gateway Base Set/).length).toBeGreaterThan(0)
  })

  it("RookiesBoardClient renders a rookie cohort row", () => {
    const { getAllByText } = render(
      <RookiesBoardClient initial={rookiesInitial} />,
    )
    expect(getAllByText(/Zaccharie Risacher/).length).toBeGreaterThan(0)
  })

  it("SetCompletersBoardClient renders a completers row", () => {
    const { getAllByText } = render(
      <SetCompletersBoardClient initialBoard={setCompletersBoard} initialFetchedAt={FETCHED} />,
    )
    expect(getAllByText(/Completers Base Set 2024/).length).toBeGreaterThan(0)
  })
})
