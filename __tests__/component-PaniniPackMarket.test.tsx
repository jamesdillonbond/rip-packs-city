// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"

import PaniniPackMarket from "@/components/packs/PaniniPackMarket"

const RECENT = new Date(Date.now() - 2 * 3_600_000).toISOString()

function product(over: Record<string, unknown> = {}) {
  return {
    id: "1038", packType: "hobby", label: "Hobby", name: "2026 Panini NFT Prizm World Cup Soccer Packs",
    labels: [{ label: "GUARANTEED", lines: ["2 Base Silver cards (each #/259)"] }],
    cardsPerPack: 4, costUsd: 144, costBasis: "floor", floorUsd: 144, avgSaleUsd: 112.38, recentSaleUsd: 142,
    topSaleUsd: 265, listedCount: 498, packsTotal: 50480, packsRemaining: 5785, rippedPct: 88.5,
    typicalEvUsd: 30, actualEvUsd: 150, netRipEdgeUsd: 6,
    legs: { silver: 4, baseParallel: 65, insert: 91, fotlExclusive: null },
    modelNote: "panini-pack-ev-0.4 · REMAINING-BASIS", updatedAt: RECENT, stale: false,
    ...over,
  }
}

function payload(over: Record<string, unknown> = {}) {
  return {
    products: [product()],
    details_error: false,
    history: [{ packType: "hobby", observedAt: RECENT, floorUsd: 144, recentSaleUsd: 142, avgSaleUsd: 112.38, packsRemaining: 5785 }],
    history_error: false,
    history_days: 30,
    stale_after_hours: 24,
    coverage: { total_editions: 5100, pct_trustworthy: 35, listing_gated_editions: null, listing_gated_families: null, families: null, edition_age_p50_h: 30, edition_age_p90_h: 47, pct_editions_stale_45d: 0 },
    coverage_error: false,
    ...over,
  }
}

function mockFetch(status: number, json: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => json })))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function mount(): Promise<HTMLElement> {
  const { container } = render(<PaniniPackMarket />)
  await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).toBeNull())
  return container
}

describe("PaniniPackMarket", () => {
  it("renders the product with typical pull ahead of the mean, and the coverage disclosure", async () => {
    mockFetch(200, payload())
    const c = await mount()
    const text = c.textContent ?? ""
    expect(text).toContain("Hobby pack · 4 cards")
    expect(text.indexOf("Typical pull")).toBeLessThan(text.indexOf("EV (mean)"))
    expect(text).toContain("$30.00")
    expect(text).toContain("+$6.00 vs cost")
    expect(c.querySelector('[data-testid="panini-coverage-note"]')).not.toBeNull()
    expect(text).toContain("5,100")
    // Fresh stats carry no stale warning.
    expect(text).not.toContain("may not be current")
  })

  it("a stale product says its prices may not be current", async () => {
    mockFetch(200, payload({ products: [product({ stale: true, updatedAt: "2026-09-20T12:00:00Z" })] }))
    const text = (await mount()).textContent ?? ""
    expect(text).toContain("may not be current")
    expect(text).toContain("more than 24 h ago")
  })

  it("an average-sale cost is labelled as such, never as a floor", async () => {
    mockFetch(200, payload({ products: [product({ costBasis: "avg_sale", floorUsd: null, costUsd: 112.38 })] }))
    const text = (await mount()).textContent ?? ""
    expect(text).toContain("Cost (avg sale — no floor)")
    expect(text).not.toMatch(/Floor\$/)
  })

  it("a failed read renders 'couldn't load', never an empty board", async () => {
    mockFetch(503, { error: "Pack market is unavailable right now." })
    const c = await mount()
    const text = c.textContent ?? ""
    expect(c.querySelector('[role="alert"]')).not.toBeNull()
    expect(text).toContain("Couldn't load packs")
    expect(text).not.toContain("No Panini pack products are tracked")
  })

  it("a failed history read is not 'no price changes'", async () => {
    mockFetch(200, payload({ history: null, history_error: true }))
    const text = (await mount()).textContent ?? ""
    expect(text).toContain("Couldn't load the price trail")
    expect(text).not.toContain("No pack price changes")
  })

  it("an empty history is stated as empty (the control)", async () => {
    mockFetch(200, payload({ history: [] }))
    const text = (await mount()).textContent ?? ""
    expect(text).toContain("No pack price changes were recorded in the last 30 days")
  })

  it("a failed coverage read keeps the disclosure and drops only the figures", async () => {
    mockFetch(200, payload({ coverage: null, coverage_error: true }))
    const c = await mount()
    expect(c.querySelector('[data-testid="panini-coverage-note"]')).not.toBeNull()
    expect(c.textContent).toContain("Coverage figures couldn")
  })
})
