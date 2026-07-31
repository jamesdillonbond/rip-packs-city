// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

// PackPageClient is the ~677-line packs feature client (the /[collection]/packs
// body) and had ZERO coverage under the component gate. It reads two useWarmCache
// caches (packs + live secondary listings), maps ApiRow -> PackRow via toPackRow
// (the dual-price / calibrated-EV / live-overlay logic), runs the filter/sort/
// price/EV controls, and toggles Standard<->Grails. These tests drive its OWN
// code: the warm-cache data/loading/error state machine, toPackRow over a real
// row, the empty state, and the view toggle — with the heavy children stubbed to
// markers so the coverage lands on PackPageClient, not PackTable/GrailsView.

// Controllable warm-cache store: any key that is NOT the live-listings key
// returns the packs slot; the live-listings key returns its own slot.
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

vi.mock("@/components/packs/PackTable", () => ({
  __esModule: true,
  default: ({ rows, emptyMessage }: { rows: unknown[]; emptyMessage: string }) => (
    <div data-testid="pack-table">{rows.length > 0 ? `rows:${rows.length}` : emptyMessage}</div>
  ),
}))
vi.mock("@/components/packs/GrailsView", () => ({
  __esModule: true,
  default: () => <div data-testid="grails-view">grails</div>,
}))

import PackPageClient from "@/components/packs/PackPageClient"

function apiRow(over: Record<string, unknown> = {}) {
  return {
    dist_id: "d1",
    title: "2025 Base Set Pack",
    image_url: "https://example.com/p.png",
    tier: "COMMON",
    pack_type: "standard",
    slots: 5,
    retail_price_usd: 9,
    pack_ev: 14,
    gross_ev: 20,
    typical_ev: 12,
    ev_margin_pct: 55,
    value_ratio: 1.5,
    fmv_coverage_pct: 90,
    depletion_pct: 20,
    ev_depletion_pct: 10,
    edition_count: 120,
    total_unopened: 500,
    ...over,
  }
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

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const baseProps = {
  collection: "nba-top-shot" as const,
  tiers: ["COMMON", "RARE", "LEGENDARY"],
  title: "Top Shot Packs",
}

describe("PackPageClient", () => {
  it("renders the title and maps warm-cache rows through toPackRow into the table", () => {
    warm.packs = { data: { rows: [apiRow(), apiRow({ dist_id: "d2", calibration_applied: true, calibrated_gross_ev: 25 })], total: 2 }, loading: false, error: null }
    const { getByText, getByTestId } = render(<PackPageClient {...baseProps} />)
    expect(getByText("Top Shot Packs")).toBeTruthy()
    expect(getByTestId("pack-table").textContent).toContain("rows:2")
  })

  it("shows the loading empty message while the packs cache is loading", () => {
    warm.packs = { data: null, loading: true, error: null }
    const { getByTestId } = render(<PackPageClient {...baseProps} />)
    expect(getByTestId("pack-table").textContent).toContain("Loading packs…")
  })

  it("surfaces a cache error", () => {
    warm.packs = { data: null, loading: false, error: new Error("packs 500") }
    const { getByText } = render(<PackPageClient {...baseProps} />)
    expect(getByText(/packs 500/)).toBeTruthy()
  })

  it("shows the no-match empty state when the pool is empty", () => {
    warm.packs = { data: { rows: [], total: 0 }, loading: false, error: null }
    const { getByTestId } = render(<PackPageClient {...baseProps} />)
    expect(getByTestId("pack-table").textContent).toContain("No packs match your filters.")
  })

  it("toggles to the Grails view", () => {
    warm.packs = { data: { rows: [apiRow()], total: 1 }, loading: false, error: null }
    const { getByText, getByTestId } = render(<PackPageClient {...baseProps} />)
    fireEvent.click(getByText("Grails"))
    expect(getByTestId("grails-view")).toBeTruthy()
  })
})
