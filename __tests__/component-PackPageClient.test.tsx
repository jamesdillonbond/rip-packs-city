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

// ── EV disclosure buyable count (2026-08-04) ───────────────────────────────
// PackTable is stubbed above, so this disclosure renders for real.
//
// The count must be computed from `historical`, NOT from `status !== 'retired'`.
// Availability is unmeasured on 3,883 of 4,596 live rows, and those now classify
// as 'unknown'; under the old literal comparison every one of them would satisfy
// `!== 'retired'` and be published as "currently buyable" — a false claim on 85%
// of the board, and the exact regression these assertions exist to catch.
describe("PackPageClient — EV disclosure never counts an unmeasured pack as buyable", () => {
  it("reports 0 of N buyable when availability was never measured", () => {
    warm.packs = {
      data: { rows: [apiRow(), apiRow({ dist_id: "d2" })], total: 2 },
      loading: false,
      error: null,
    }
    const { container } = render(<PackPageClient {...baseProps} />)
    const text = (container.textContent ?? "").replace(/\s+/g, " ")
    expect(text).toContain("0 of 2")
    expect(text).toContain("currently buyable")
    // and it must not tell the reader the rest were checked and found retired
    expect(text).not.toMatch(/The rest are retired/i)
  })

  it("counts a genuinely buyable pack, and only that one", () => {
    warm.packs = {
      data: {
        rows: [
          apiRow({ dist_id: "live", secondary_available: true }),
          apiRow({ dist_id: "unmeasured" }),
        ],
        total: 2,
      },
      loading: false,
      error: null,
    }
    const { container } = render(<PackPageClient {...baseProps} />)
    expect((container.textContent ?? "").replace(/\s+/g, " ")).toContain("1 of 2")
  })
})

// ── Filter / sort interaction layer (the dark branches) ────────────────────────
// PackTable is stubbed to `rows:N`, so a filter that removes a row is observable
// as the count dropping. Each toggle judges gross_ev vs the SECONDARY ask.
const rowsText = (c: HTMLElement) => c.querySelector('[data-testid="pack-table"]')!.textContent ?? ""

describe("PackPageClient — filters, quick toggles, sort, price range", () => {
  it("+EV only keeps rows whose gross EV beats the secondary ask and drops the rest", () => {
    warm.packs = {
      data: {
        rows: [
          apiRow({ dist_id: "pos", gross_ev: 50, secondary_available: true, secondary_ask: 30 }), // 50-30>0 keep
          apiRow({ dist_id: "neg", gross_ev: 20, secondary_available: true, secondary_ask: 30 }), // 20-30<=0 drop
          apiRow({ dist_id: "noask", gross_ev: 50, secondary_available: false, secondary_ask: null }), // no verdict → drop
        ],
        total: 3,
      },
      loading: false, error: null,
    }
    const { getByText, container } = render(<PackPageClient {...baseProps} />)
    expect(rowsText(container)).toContain("rows:3")
    fireEvent.click(getByText("+EV only"))
    expect(rowsText(container)).toContain("rows:1")
    // header now reads "1 of 3 distributions"
    expect((container.textContent ?? "").replace(/\s+/g, " ")).toContain("1 of 3")
    // Clear resets
    fireEvent.click(getByText("Clear"))
    expect(rowsText(container)).toContain("rows:3")
  })

  it("Has chasers keeps rows with EV/ask ratio ≥ 1", () => {
    warm.packs = {
      data: {
        rows: [
          apiRow({ dist_id: "hi", gross_ev: 40, secondary_available: true, secondary_ask: 30 }), // 40/30>=1 keep
          apiRow({ dist_id: "lo", gross_ev: 20, secondary_available: true, secondary_ask: 30 }), // 20/30<1 drop
        ],
        total: 2,
      },
      loading: false, error: null,
    }
    const { getByText, container } = render(<PackPageClient {...baseProps} />)
    fireEvent.click(getByText(/Has chasers/))
    expect(rowsText(container)).toContain("rows:1")
  })

  it("Almost sold out keeps rows with pool depletion ≥ 80%", () => {
    warm.packs = {
      data: {
        rows: [
          apiRow({ dist_id: "sold", ev_depletion_pct: 90 }),
          apiRow({ dist_id: "fresh", ev_depletion_pct: 10 }),
        ],
        total: 2,
      },
      loading: false, error: null,
    }
    const { getByText, container } = render(<PackPageClient {...baseProps} />)
    fireEvent.click(getByText("Almost sold out"))
    expect(rowsText(container)).toContain("rows:1")
  })

  it("filters by a pack-type chip (chips only appear when the column is populated)", () => {
    warm.packs = {
      data: {
        rows: [
          apiRow({ dist_id: "std", pack_type: "standard" }),
          apiRow({ dist_id: "prem", pack_type: "premium" }),
        ],
        total: 2,
      },
      loading: false, error: null,
    }
    const { getByText, container } = render(<PackPageClient {...baseProps} />)
    fireEvent.click(getByText("premium")) // pack_type chip (lowercase text; CSS-capitalized)
    expect(rowsText(container)).toContain("rows:1")
  })

  it("filters by the price min/max range and clears it", () => {
    warm.packs = {
      data: {
        rows: [
          apiRow({ dist_id: "cheap", retail_price_usd: 9, pack_type: null }),
          apiRow({ dist_id: "pricey", retail_price_usd: 100, pack_type: null }),
        ],
        total: 2,
      },
      loading: false, error: null,
    }
    const { getByPlaceholderText, container } = render(<PackPageClient {...baseProps} />)
    fireEvent.change(getByPlaceholderText("Min"), { target: { value: "50" } })
    expect(rowsText(container)).toContain("rows:1") // only the $100 row
    fireEvent.change(getByPlaceholderText("Max"), { target: { value: "40" } })
    expect(rowsText(container)).toContain("No packs match your filters.") // min50 & max40 exclude both
    // the price-range Clear button (the only "Clear" visible now) resets both inputs
    const priceClear = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Clear")
    fireEvent.click(priceClear!)
    expect(rowsText(container)).toContain("rows:2")
  })

  it("changing the sort switches the tableSortFor mapping (covers every sort key)", () => {
    warm.packs = { data: { rows: [apiRow()], total: 1 }, loading: false, error: null }
    const { container } = render(<PackPageClient {...baseProps} />)
    const select = container.querySelector("select")!
    // the default banner is present for display_price_asc
    expect(container.textContent).toContain("Sorted cheapest pack first")
    for (const key of [
      "value_ratio_desc", "ev_margin_pct_desc", "pack_ev_dollar_desc", "grail_premium_desc",
      "retail_price_asc", "pool_depletion_pct_desc", "total_unopened_asc", "title_asc",
    ]) {
      fireEvent.change(select, { target: { value: key } })
    }
    // sorting away from the default drops the banner
    expect(container.textContent).not.toContain("Sorted cheapest pack first")
  })

  it("selecting a tier chip and typing in the search box exercise the filter controls", () => {
    warm.packs = { data: { rows: [apiRow()], total: 1 }, loading: false, error: null }
    const { getByText, getByPlaceholderText, container } = render(<PackPageClient {...baseProps} />)
    fireEvent.click(getByText("LEGENDARY")) // tier chip (text is uppercase; `capitalize` is CSS-only)
    fireEvent.change(getByPlaceholderText("Search packs by name…"), { target: { value: "base" } })
    expect(container.querySelector('[data-testid="pack-table"]')).toBeTruthy()
  })

  it("renders the LIVE overlay counter when a row gets a live secondary ask", () => {
    warm.packs = { data: { rows: [apiRow({ dist_id: "d1", gross_ev: 50 })], total: 1 }, loading: false, error: null }
    warm.listings = { data: { listings: [{ distId: "d1", lowestAsk: 30, listingCount: 5, packListingId: "u" }] }, loading: false, error: null }
    const { container } = render(<PackPageClient {...baseProps} />)
    expect(container.textContent).toContain("1 LIVE")
  })

  it("Pinnacle hides $0/no-EV reward packs by default and reveals them on the toggle", () => {
    warm.packs = {
      data: {
        rows: [
          apiRow({ dist_id: "priced", retail_price_usd: 5, gross_ev: 8 }),
          apiRow({ dist_id: "reward", retail_price_usd: 0, gross_ev: 0 }), // hidden by default
        ],
        total: 2,
      },
      loading: false, error: null,
    }
    const props = { ...baseProps, collection: "disney-pinnacle" as const }
    const { getByText, container } = render(<PackPageClient {...props} />)
    expect(rowsText(container)).toContain("rows:1") // reward pack hidden
    fireEvent.click(getByText("Show $0 / reward packs"))
    expect(rowsText(container)).toContain("rows:2")
  })
})
