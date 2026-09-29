// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

// Companion to component-PackPageClient.test.tsx. That suite stubs PackTable to
// show only a row COUNT, so toPackRow's dual-price / live-overlay / calibrated-EV
// branches ran but nothing could assert their OUTPUT. Here PackTable is stubbed
// to emit the mapped PackRow fields as JSON, so we can pin what toPackRow
// actually computes: the live-overlay secondary ask + venue buy link (TS vs
// AllDay), the cached-secondary fallback, the primary/secondary/retail
// displayPrice ladder, the EV-net-$ / margin verdict anchoring, and calibration.

const warm: { packs: any; listings: any } = {
  packs: { data: null, loading: false, error: null },
  listings: { data: null, loading: false, error: null },
}
vi.mock("@/lib/warmup/WarmupContext", () => ({
  useWarmCache: (key: string) => {
    const slot = key.startsWith("pack-live-listings:") ? warm.listings : warm.packs
    return { data: slot.data, loading: slot.loading, error: slot.error, refresh: vi.fn() }
  },
}))

// Expose the mapped rows as JSON so the test can read toPackRow's output.
vi.mock("@/components/packs/PackTable", () => ({
  __esModule: true,
  default: ({ rows }: { rows: any[] }) => (
    <div
      data-testid="rows-json"
      data-rows={JSON.stringify(
        rows.map((r) => ({
          id: r.id,
          buyUrl: r.buyUrl,
          secondaryAsk: r.secondaryAsk,
          secondaryAskSource: r.secondaryAskSource,
          secondaryListingCount: r.secondaryListingCount,
          priceSource: r.priceSource,
          displayPrice: r.displayPrice,
          grossEV: r.grossEV,
          packEvDollar: r.packEvDollar,
          evMarginPct: r.evMarginPct,
          calibrationApplied: r.calibrationApplied,
          dropPool: r.dropPool,
          lowConfidenceTitle: r.lowConfidenceTitle,
        })),
      )}
    />
  ),
}))
vi.mock("@/components/packs/GrailsView", () => ({ __esModule: true, default: () => <div /> }))

import PackPageClient from "@/components/packs/PackPageClient"

function apiRow(over: Record<string, unknown> = {}) {
  return {
    dist_id: "d1",
    title: "Pack",
    image_url: "https://x/p.png",
    tier: "COMMON",
    pack_type: "standard",
    slots: 5,
    retail_price_usd: 9,
    gross_ev: 50,
    typical_ev: 12,
    edition_count: 100,
    total_unopened: 400,
    ...over,
  }
}

function liveListing(over: Record<string, unknown> = {}) {
  return { distId: "d1", lowestAsk: 30, listingCount: 5, packListingId: "pl-uuid", ...over }
}

beforeEach(() => {
  warm.packs = { data: null, loading: false, error: null }
  warm.listings = { data: null, loading: false, error: null }
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: false, media: q, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia
  }
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ rows: [], total: 0 }) } as Response)))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const props = (collection: "nba-top-shot" | "nfl-all-day" = "nba-top-shot") => ({
  collection,
  tiers: ["COMMON", "RARE", "LEGENDARY"],
  title: "Packs",
})

function readRows(container: HTMLElement): any[] {
  return JSON.parse(container.querySelector('[data-testid="rows-json"]')!.getAttribute("data-rows")!)
}

describe("PackPageClient toPackRow — live secondary overlay (Top Shot)", () => {
  it("takes the live lowest ask, tags it 'live', anchors the EV verdict, and builds a Top Shot buy link", () => {
    warm.packs = { data: { rows: [apiRow({ gross_ev: 50 })], total: 1 }, loading: false, error: null }
    warm.listings = { data: { listings: [liveListing({ lowestAsk: 30, listingCount: 5 })] }, loading: false, error: null }
    const [row] = readRows(render(<PackPageClient {...props()} />).container)
    expect(row.secondaryAsk).toBe(30)
    expect(row.secondaryAskSource).toBe("live")
    expect(row.secondaryListingCount).toBe(5)
    expect(row.priceSource).toBe("secondary")
    // verdict anchors gross EV to the live ask: 50 - 30 = 20 net, 20/30 margin.
    expect(row.packEvDollar).toBe(20)
    expect(row.evMarginPct).toBeCloseTo(20 / 30, 5)
    // display price falls to the secondary ask (no primary), and the TS buy link is set.
    expect(row.displayPrice).toBe(30)
    expect(typeof row.buyUrl).toBe("string")
    expect(row.buyUrl).toContain("d1")
  })
})

describe("PackPageClient toPackRow — AllDay live overlay uses the dapper.market link", () => {
  it("routes the buy link to dapper.market for nfl-all-day", () => {
    warm.packs = { data: { rows: [apiRow()], total: 1 }, loading: false, error: null }
    warm.listings = { data: { listings: [liveListing()] }, loading: false, error: null }
    const [row] = readRows(render(<PackPageClient {...props("nfl-all-day")} />).container)
    expect(row.buyUrl).toContain("dapper.market")
  })
})

describe("PackPageClient toPackRow — no live overlay", () => {
  it("falls back to the cached secondary ask (source 'cached') with no buy link", () => {
    warm.packs = {
      data: { rows: [apiRow({ gross_ev: 40, secondary_ask: 25, secondary_available: true })], total: 1 },
      loading: false, error: null,
    }
    const [row] = readRows(render(<PackPageClient {...props()} />).container)
    expect(row.secondaryAsk).toBe(25)
    expect(row.secondaryAskSource).toBe("cached")
    expect(row.packEvDollar).toBe(15) // 40 - 25
    expect(row.displayPrice).toBe(25)
    expect(row.buyUrl).toBeNull() // no overlay -> no confirmed-active listing -> no link
  })

  it("prefers a live PRIMARY price over the secondary ask for displayPrice", () => {
    warm.packs = {
      data: { rows: [apiRow({ primary_price: 9, primary_available: true, secondary_ask: 25, secondary_available: true })], total: 1 },
      loading: false, error: null,
    }
    const [row] = readRows(render(<PackPageClient {...props()} />).container)
    expect(row.displayPrice).toBe(9) // primary wins the ladder
    expect(row.secondaryAsk).toBe(25) // still surfaced separately
  })

  it("carries a gross EV but NO net verdict when there is no secondary ask at all", () => {
    warm.packs = { data: { rows: [apiRow({ gross_ev: 40, secondary_ask: null, secondary_available: false })], total: 1 }, loading: false, error: null }
    const [row] = readRows(render(<PackPageClient {...props()} />).container)
    expect(row.grossEV).toBe(40)
    expect(row.packEvDollar).toBeNull() // no verdict anchor
    expect(row.evMarginPct).toBeNull()
    expect(row.displayPrice).toBe(9) // retail fallback
  })
})

describe("PackPageClient toPackRow — calibrated EV overlay", () => {
  it("uses the calibrated gross EV as the headline and flags calibrationApplied", () => {
    warm.packs = {
      data: { rows: [apiRow({ gross_ev: 20, calibration_applied: true, calibrated_gross_ev: 25 })], total: 1 },
      loading: false, error: null,
    }
    const [row] = readRows(render(<PackPageClient {...props()} />).container)
    expect(row.grossEV).toBe(25) // calibrated wins over the raw 20
    expect(row.calibrationApplied).toBe(true)
  })
})

// 2026-09-28 (#157) — a Pinnacle sub-pool row carries its drop, and its
// low-confidence reason is ask-driven value, not All Day's stale FMV.
describe("PackPageClient toPackRow — Pinnacle drop pools", () => {
  it("maps drop_title/drop_pools/pool_* into dropPool and names the ask share", () => {
    warm.packs = { data: { rows: [apiRow({
      drop_title: "Summer Splash - Standard", drop_pools: 6, pool_name: "Quinova",
      pool_share_pct: 0.2, pool_gross_ev: 4050, sales_backed_ev: 6.22, ask_value_share_pct: 82.8,
      low_confidence_ev: true,
    })], total: 1 }, loading: false, error: null }
    const [row] = readRows(render(<PackPageClient {...props()} />).container)
    expect(row.dropPool).toEqual({ dropTitle: "Summer Splash - Standard", pools: 6, poolName: "Quinova", sharePct: 0.2, poolEv: 4050 })
    expect(row.lowConfidenceTitle).toContain("83% of this pack's EV rests on asking prices")
    expect(row.lowConfidenceTitle).toContain("$6.22 of it is backed by sales")
  })

  it("CONTROL: a pack that is not a sub-pool has no dropPool and keeps the default caveat text", () => {
    warm.packs = { data: { rows: [apiRow({ drop_title: null, drop_pools: 1, ask_value_share_pct: 10 })], total: 1 }, loading: false, error: null }
    const [row] = readRows(render(<PackPageClient {...props()} />).container)
    expect(row.dropPool).toBeNull()
    expect(row.lowConfidenceTitle).toBeNull()
  })

  it("names the ask share even when the sales-backed figure is unknown", () => {
    warm.packs = { data: { rows: [apiRow({ ask_value_share_pct: 60, sales_backed_ev: null })], total: 1 }, loading: false, error: null }
    const [row] = readRows(render(<PackPageClient {...props()} />).container)
    expect(row.lowConfidenceTitle).toContain("60% of this pack's EV")
    expect(row.lowConfidenceTitle).not.toContain("backed by sales")
  })
})
