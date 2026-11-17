// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import CollectionMomentTable from "@/components/collection/CollectionMomentTable"

// 2026-11-16 (Trevor, from a phone screenshot of the binder):
//   1. "badges look incorrect" — a three-star rookie card HID Rookie Year / Premiere /
//      Mint but never drew the Three-Star badge that replaces them, so Walter Clayton
//      Jr. read as a bare Top Shot Debut. The desktop row always drew it.
//   2. "we should show Team, FMV, Low Ask, High Offer, Acquisition Price, Acquisition
//      Date, all on this main card" — six labelled cells, no tap needed.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }))
afterEach(() => cleanup())

function row(over: Record<string, any> = {}): any {
  return {
    momentId: "m1", flowId: "f1", playerName: "Walter Clayton Jr.", team: "Utah Jazz",
    setName: "Rookie Debut", tier: "COMMON", editionKey: "219:7424", serialNumber: 34, mintCount: 50,
    fmv: 13, badgeInfo: null, parallel: null, subedition: null, editionsOwned: 1, editionsLocked: 0,
    lowAsk: null, editionLowAsk: null, bestOffer: null, editionBestOffer: null, lastPurchasePrice: null,
    costBasis: null, costBasisLabel: null, acquiredAt: null,
    ...over,
  }
}

const props = (over: Record<string, any> = {}) => ({
  isMobile: true, filteredRows: [row()], rowsCount: 1, summary: { totalMoments: 1 } as any,
  view: { expandedRows: {}, sortKey: "player", sortDir: "asc" } as any, toggleExpanded: vi.fn(),
  batchEditionStats: new Map(), costBasis: new Map(), collectionSeriesMap: new Map(),
  collectionSlug: "nba-top-shot", badgeCollectionId: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  connectedWallet: null, ownerKey: "0xabc", input: "0xabc", hasSearched: true, loading: false,
  showDebug: false, getPackCount: () => 0, accent: "#E03A2F", ...over,
})

function stat(container: HTMLElement, key: string): string {
  const el = container.querySelector(`[data-rpc-card-stat="${key}"]`)
  if (!el) throw new Error("no stat cell " + key)
  return el.textContent ?? ""
}

describe("mobile card draws the Three-Star Rookie badge it collapses into", () => {
  it("a three-star rookie with a rookie mint shows Three-Star Rookie, not the component pills", () => {
    const { container } = render(<CollectionMomentTable {...props({ filteredRows: [row({ badgeInfo: {
      is_three_star_rookie: true, has_rookie_mint: true,
      badge_titles: ["Rookie Year", "Rookie Premiere", "Rookie Mint", "Top Shot Debut"],
    } })] })} />)
    const t = container.textContent ?? ""
    expect(t).toContain("Three-Star Rookie")
    expect(t).toContain("Top Shot Debut")
    expect(t).not.toContain("Rookie Premiere")
  })

  it("a non-three-star rookie keeps its component pills and gets no Three-Star badge", () => {
    const { container } = render(<CollectionMomentTable {...props({ filteredRows: [row({ badgeInfo: {
      is_three_star_rookie: false, has_rookie_mint: true, badge_titles: ["Rookie Year", "Rookie Mint"],
    } })] })} />)
    const t = container.textContent ?? ""
    expect(t).toContain("Rookie Year")
    expect(t).toContain("Rookie Mint")
    expect(t).not.toContain("Three-Star Rookie")
  })
})

describe("mobile card shows the six numbers without a tap", () => {
  it("renders Team, FMV, Low Ask, High Offer, Paid and Acquired with their values", () => {
    const { container } = render(<CollectionMomentTable {...props({ filteredRows: [row({
      lowAsk: 14.5, bestOffer: 11, costBasis: 9, costBasisLabel: "Bought", acquiredAt: "2026-11-15T20:00:00Z",
    })] })} />)
    expect(stat(container, "team")).toContain("Utah Jazz")
    expect(stat(container, "fmv")).toContain("13")
    expect(stat(container, "low-ask")).toContain("$14.50")
    expect(stat(container, "high-offer")).toContain("$11.00")
    expect(stat(container, "paid")).toContain("$9.00")
    expect(stat(container, "acquired")).toMatch(/Nov 1[45], 2026/)
  })

  it("an unread value is a dash, never a zero — and a past SALE never fills Low Ask", () => {
    const { container } = render(<CollectionMomentTable {...props({ filteredRows: [row({ team: undefined, recentLow30d: 10 })] })} />)
    expect(stat(container, "team")).toBe("Team—")
    expect(stat(container, "low-ask")).toMatch(/^Low Ask—/)
    expect(stat(container, "low-ask")).toContain("recent low $10.00")
    expect(stat(container, "high-offer")).toBe("High Offer—")
    expect(stat(container, "paid")).toBe("Paid—")
    expect(stat(container, "acquired")).toBe("Acquired—")
    expect(container.querySelector('[data-rpc-mobile-card-stats=""]')?.textContent).not.toMatch(/\$0\.00/)
  })

  it("falls back to the edition floor and the edition offer, labelled", () => {
    const { container } = render(<CollectionMomentTable {...props({ filteredRows: [row({ editionLowAsk: 20, editionBestOffer: 8 })] })} />)
    expect(stat(container, "low-ask")).toContain("floor")
    expect(stat(container, "high-offer")).toContain("$8.00")
  })

  it("acquired date falls back to the cost-basis record's date", () => {
    const { container } = render(<CollectionMomentTable {...props({
      costBasis: new Map([["f1", { buyPrice: 12, acquiredDate: "2026-03-02T12:00:00Z", fmvAtAcquisition: null, acquisitionMethod: null, costBasisLabel: "Bought" }]]),
    })} />)
    expect(stat(container, "acquired")).toContain("Mar 2, 2026")
    expect(stat(container, "paid")).toContain("$12.00")
  })

  it("Disney Pinnacle has no Team cell (pins carry no team)", () => {
    const { container } = render(<CollectionMomentTable {...props({ collectionSlug: "disney-pinnacle" })} />)
    expect(container.querySelector('[data-rpc-card-stat="team"]')).toBeNull()
    expect(container.querySelector('[data-rpc-card-stat="fmv"]')).not.toBeNull()
  })
})
