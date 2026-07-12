import { describe, it, expect, beforeEach, vi } from "vitest"

// Pins lib/packs/pack-deals.ts::getPackDeals — the Pack Sniper deal feed that
// joins live sealed-pack asks to the gated pack-EV rows, applies the honesty /
// high-variance gates, overlays recency, and orders the board. The two external
// seams (live listings + Supabase) are mocked so the pure join/gate/recency/sort
// logic is driven directly: matched vs unmatched, high-variance reason flags,
// includeHighVariance filtering, discount/value ratios, NEW / price-drop windows,
// and the recency-then-value ordering.

const state: {
  listings: any[]
  evRows: any[]
  evError: { message: string } | null
  askMap: Record<string, any> | null
  askError: { message: string } | null
} = { listings: [], evRows: [], evError: null, askMap: null, askError: null }

vi.mock("@/lib/packs/live-pack-listings", () => ({
  isSupportedPackCollection: (s: string) => s === "nba-top-shot" || s === "nfl-all-day",
  fetchLivePackListings: async () => ({ listings: state.listings }),
}))

vi.mock("@/lib/pack-urls", () => ({
  topshotPackUrl: () => "https://ts/pack",
  dapperMarketPackUrl: () => "https://dapper/pack",
  alldayPackUrl: () => "https://ad/pack",
}))

vi.mock("@/lib/supabase", () => {
  // Thenable query builder: every chained filter returns the builder; awaiting it
  // resolves to the ev result. rpc() resolves to the ask-state map.
  const builder: any = {}
  for (const m of ["select", "eq", "not", "gte", "lt", "limit"]) builder[m] = () => builder
  builder.then = (resolve: any) => resolve({ data: state.evRows, error: state.evError })
  const client: any = {
    from: () => builder,
    rpc: async () => ({ data: state.askMap, error: state.askError }),
  }
  return { supabase: client, supabaseAdmin: client }
})

import { getPackDeals } from "@/lib/packs/pack-deals"

function listing(over: Partial<any> = {}): any {
  return {
    packListingId: "L1",
    distId: "100",
    title: "Test Pack",
    tier: "common",
    imageUrl: "img",
    momentsPerPack: 4,
    retailPrice: 9,
    lowestAsk: 10,
    startTime: "",
    listingCount: 1,
    packType: "standard",
    seriesLabel: "S4",
    ...over,
  }
}

function evRow(over: Partial<any> = {}): any {
  return {
    dist_id: "100",
    gross_ev: 20,
    fmv_coverage_pct: 95,
    ev_snapshotted_at: "2026-07-12T00:00:00Z",
    is_rare_single_pack: false,
    depletion_pct: 10,
    edition_count: 50,
    slots: 4,
    ...over,
  }
}

beforeEach(() => {
  state.listings = []
  state.evRows = []
  state.evError = null
  state.askMap = null
  state.askError = null
})

describe("getPackDeals — guards", () => {
  it("throws on an unsupported collection", async () => {
    await expect(getPackDeals("disney-pinnacle")).rejects.toThrow(/Unsupported collection/)
  })

  it("throws when the EV read errors", async () => {
    state.evError = { message: "db down" }
    await expect(getPackDeals("nba-top-shot")).rejects.toThrow(/pack_table_rows read failed: db down/)
  })
})

describe("getPackDeals — join & value math", () => {
  it("matches a listing to its EV row and computes ratio/discount", async () => {
    state.listings = [listing({ distId: "100", lowestAsk: 10 })]
    state.evRows = [evRow({ dist_id: "100", gross_ev: 20 })]
    const { deals, stats } = await getPackDeals("nba-top-shot")
    expect(stats.matched).toBe(1)
    expect(stats.positiveEv).toBe(1) // ratio 2 > 1
    expect(deals).toHaveLength(1)
    expect(deals[0].liveValueRatio).toBe(2)
    // discount = 1 - ask/ev = 1 - 10/20 = 0.5
    expect(deals[0].discountPct).toBeCloseTo(0.5, 5)
  })

  it("skips listings with no matching EV row and non-positive asks", async () => {
    state.listings = [listing({ distId: "100" }), listing({ distId: "999", packListingId: "L2" }), listing({ distId: "100", lowestAsk: 0, packListingId: "L3" })]
    state.evRows = [evRow({ dist_id: "100" })]
    const { deals, stats } = await getPackDeals("nba-top-shot")
    expect(stats.matched).toBe(1) // only the distId 100 with positive ask
    expect(deals).toHaveLength(1)
  })
})

describe("getPackDeals — high-variance gating", () => {
  it("flags reasons and can drop high-variance packs", async () => {
    // ratio 30/10 = 3 (not > 3), so trigger via depletion + coverage + slots.
    state.listings = [listing({ distId: "100", lowestAsk: 10, momentsPerPack: 1 })]
    state.evRows = [evRow({ dist_id: "100", gross_ev: 15, depletion_pct: 65, fmv_coverage_pct: 70, slots: 1 })]
    const withHv = await getPackDeals("nba-top-shot", { includeHighVariance: true })
    expect(withHv.deals[0].highVariance).toBe(true)
    expect(withHv.deals[0].highVarianceReasons).toEqual(
      expect.arrayContaining(["depleted_60pct", "thin_fmv_coverage", "single_slot_chase"]),
    )
    expect(withHv.stats.highVariance).toBe(1)

    const noHv = await getPackDeals("nba-top-shot", { includeHighVariance: false })
    expect(noHv.deals).toHaveLength(0)
    expect(noHv.stats.highVariance).toBe(1) // still counted, just not returned
  })

  it("flags ev_gt_3x_ask when the ratio exceeds 3", async () => {
    state.listings = [listing({ distId: "100", lowestAsk: 10 })]
    state.evRows = [evRow({ dist_id: "100", gross_ev: 40 })] // ratio 4
    const { deals } = await getPackDeals("nba-top-shot")
    expect(deals[0].highVarianceReasons).toContain("ev_gt_3x_ask")
  })
})

describe("getPackDeals — recency overlay", () => {
  it("marks a freshly-listed dist as NEW and orders it first", async () => {
    const now = new Date()
    const recent = new Date(now.getTime() - 60 * 1000).toISOString() // 1 min ago (within 120m window)
    const old = new Date(now.getTime() - 10 * 60 * 60 * 1000).toISOString() // 10h ago
    state.listings = [
      listing({ distId: "100", packListingId: "A" }),
      listing({ distId: "200", packListingId: "B" }),
    ]
    state.evRows = [evRow({ dist_id: "100" }), evRow({ dist_id: "200" })]
    state.askMap = {
      "100": { lowest_ask: 10, prev_ask: null, ask_first_seen_at: old, ask_changed_at: old, low_ask_24h: null, low_ask_7d: null },
      "200": { lowest_ask: 10, prev_ask: null, ask_first_seen_at: recent, ask_changed_at: recent, low_ask_24h: null, low_ask_7d: null },
    }
    const { deals } = await getPackDeals("nba-top-shot")
    // dist 200 changed most recently → sorts first, and is flagged NEW.
    expect(deals[0].distId).toBe("200")
    expect(deals[0].isNew).toBe(true)
    expect(deals[1].isNew).toBe(false)
  })

  it("flags a price drop (not new) and computes askDropPct", async () => {
    const now = new Date()
    const changed = new Date(now.getTime() - 30 * 60 * 1000).toISOString() // 30m ago
    const firstSeen = new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString() // 5h ago (not new)
    state.listings = [listing({ distId: "100", lowestAsk: 8 })]
    state.evRows = [evRow({ dist_id: "100" })]
    state.askMap = {
      "100": { lowest_ask: 8, prev_ask: 10, ask_first_seen_at: firstSeen, ask_changed_at: changed, low_ask_24h: 8, low_ask_7d: 8 },
    }
    const { deals } = await getPackDeals("nba-top-shot")
    expect(deals[0].isNew).toBe(false)
    expect(deals[0].isPriceDrop).toBe(true)
    expect(deals[0].askDropPct).toBeCloseTo(0.2, 5) // 1 - 8/10
    expect(deals[0].atLow24h).toBe(true) // ask 8 <= low_ask_24h 8
  })

  it("degrades gracefully when the ask-state RPC errors (no recency flags)", async () => {
    state.listings = [listing({ distId: "100" })]
    state.evRows = [evRow({ dist_id: "100" })]
    state.askError = { message: "rpc down" }
    const { deals } = await getPackDeals("nba-top-shot")
    expect(deals[0].isNew).toBe(false)
    expect(deals[0].askChangedAt).toBeNull()
  })
})

describe("getPackDeals — limit", () => {
  it("caps the returned deals at the requested limit", async () => {
    state.listings = Array.from({ length: 5 }, (_, i) =>
      listing({ distId: String(i), packListingId: `L${i}` }),
    )
    state.evRows = Array.from({ length: 5 }, (_, i) => evRow({ dist_id: String(i) }))
    const { deals, stats } = await getPackDeals("nba-top-shot", { limit: 2 })
    expect(deals).toHaveLength(2)
    expect(stats.matched).toBe(5)
    expect(stats.returned).toBe(2)
  })
})
