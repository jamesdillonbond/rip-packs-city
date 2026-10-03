// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"

vi.mock("@/components/MomentMedia", () => ({
  default: (p: { thumbnailUrl?: string | null }) => <span data-testid="pack-art" data-src={p.thumbnailUrl ?? ""} />,
}))

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
    // Re-pinned 2026-09-28: EV renders only for a product the model prices (explicit true).
    productName: "2026 Panini NFT Prizm World Cup Soccer", sport: "SOCCER", evModeled: true,
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

  it("an un-typed secondary-market pack heads with its own name, never 'Pack pack', and says EV is not modeled", async () => {
    // 2026-10-03: the secondary pack grid brought in ~40 packs of ~15 products; one product can carry
    // a dozen distinct packs, so the pack's own published name is what tells them apart.
    mockFetch(200, payload({ products: [product({
      id: "1", packType: "pack", label: "Pack", name: "2020-21 Panini NFT Blockchain Prizm NBA Red Mosaic Packs",
      productName: "2021 Panini Blockchain NBA Packs Entertainment", sport: "BASKETBALL", evModeled: false, cardsPerPack: 3,
      labels: [{ label: "GUARANTEED", lines: ["3 Red Mosaic Parallel NFTs"] }],
    })] }))
    const c = await mount()
    const h = c.querySelector('[data-testid="panini-pack-1"] h2')?.textContent ?? ""
    expect(h).toBe("2020-21 Panini NFT Blockchain Prizm NBA Red Mosaic Packs · 3 cards")
    const text = c.querySelector('[data-testid="panini-pack-1"]')?.textContent ?? ""
    expect(text).not.toMatch(/Pack pack/i)
    expect(text).not.toContain("Hobby")
    expect(text).toContain("2021 Panini Blockchain NBA Packs Entertainment")
    expect(text).toContain("Not modeled")
    expect(text).toContain("3 Red Mosaic Parallel NFTs")
  })

  it("the price trail names a secondary pack by its own name, even on a history row stamped 'hobby' before 10-03", async () => {
    mockFetch(200, payload({
      products: [product({ id: "1", packType: "pack", label: "Pack", name: "2020-21 Panini NFT Blockchain Prizm NBA Red Mosaic Packs", productName: "2021 Panini Blockchain NBA Packs Entertainment", evModeled: false })],
      history: [{ packId: "1", packType: "hobby", observedAt: RECENT, floorUsd: 19900, recentSaleUsd: 15500, avgSaleUsd: 4179, packsRemaining: 32 }],
    }))
    const c = await mount()
    const rows = [...c.querySelectorAll("tr")].map((r) => r.textContent ?? "")
    const trail = rows.find((r) => r.includes("$19,900"))
    expect(trail).toContain("Red Mosaic Packs")
    expect(trail).not.toContain("Hobby")
  })

  it("renders pack art only when the product carries an image URL", async () => {
    mockFetch(200, payload({ products: [product({ imageUrl: "https://assets.paniniamerica.net/catalog/product/pack/pack_enh_bc_1038.png" }), product({ id: "1039", packType: "fotl", label: "FOTL", imageUrl: null })] }))
    const c = await mount()
    const art = c.querySelectorAll('[data-testid="pack-art"]')
    expect(art).toHaveLength(1)
    expect(art[0].getAttribute("data-src")).toBe("https://assets.paniniamerica.net/catalog/product/pack/pack_enh_bc_1038.png")
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

// Multi-product (2026-09-28): a pack whose product the model does not price must show its market
// stats and say "Not modeled" — never an EV number (a leaked WC figure) and never a bare "—" tile
// that reads as "worth nothing". The fixture deliberately carries EV figures, as a regressed payload
// would, to prove the component itself refuses to render them.
describe("PaniniPackMarket — unmodeled products", () => {
  const wnba = product({
    id: "PZM-WNBA-FOTL", packType: "fotl", label: "FOTL", name: "2026 Panini NFT Prizm WNBA FOTL Packs",
    productName: "2026 Panini NFT Prizm WNBA", sport: "BASKETBALL", evModeled: false,
    typicalEvUsd: 777, actualEvUsd: 888, netRipEdgeUsd: 99, costUsd: 199, floorUsd: 199,
    legs: { silver: 4, baseParallel: 65, insert: 91, fotlExclusive: 114 }, modelNote: "not modeled · x",
  })

  it("renders cost and supply, says Not modeled, and shows no EV figure or EV legs", async () => {
    mockFetch(200, payload({ products: [product(), wnba] }))
    const c = await mount()
    const card = c.querySelector('[data-testid="panini-pack-PZM-WNBA-FOTL"]')!
    expect(card.getAttribute("data-ev-modeled")).toBe("false")
    const t = card.textContent ?? ""
    expect(t).toContain("Not modeled")
    expect(t).toContain("$199")
    for (const leaked of ["$777", "$888", "+$99", "EV legs", "Typical pull"]) expect(t).not.toContain(leaked)
    const wc = c.querySelector('[data-testid="panini-pack-1038"]')!
    expect(wc.getAttribute("data-ev-modeled")).toBe("true")
    expect(wc.textContent).toContain("Typical pull")
  })

  it("names the product in the price trail when two products' packs share a type", async () => {
    mockFetch(200, payload({
      products: [product({ id: "1039", packType: "fotl", label: "FOTL" }), wnba],
      history: [
        { packId: "PZM-WNBA-FOTL", packType: "fotl", observedAt: RECENT, floorUsd: 199, recentSaleUsd: 190, avgSaleUsd: 180, packsRemaining: 100 },
        { packId: "1039", packType: "fotl", observedAt: RECENT, floorUsd: 245, recentSaleUsd: 261, avgSaleUsd: 300, packsRemaining: 1480 },
      ],
    }))
    const c = await mount()
    const rows = [...c.querySelectorAll("tbody tr")].map((r) => r.textContent ?? "").filter((t) => t.includes("PT"))
    expect(rows.some((r) => r.includes("2026 Panini NFT Prizm WNBA · FOTL"))).toBe(true)
    expect(rows.some((r) => r.includes("FOTL") && !r.includes("WNBA"))).toBe(true)
  })
})

