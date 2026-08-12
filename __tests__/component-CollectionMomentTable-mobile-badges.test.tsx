// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import CollectionMomentTable from "@/components/collection/CollectionMomentTable"

// The remaining uncovered branches in the collection-page moment table (85 —
// the largest single gap in the component gate). Two clusters, both of which
// change what a collector is TOLD rather than whether the page renders:
//
//   1. The MOBILE card layout (isMobile) — a near-complete second render tree
//      that the desktop-oriented suites never enter, carrying its own copies of
//      the badge, cost-basis and edition-count logic.
//   2. The two DISTINCT empty states. "No moments found for this wallet on this
//      collection" and "No moments match your current filters" are different
//      claims: one says you own nothing here, the other says your filters are
//      too tight. Collapsing them tells a collector who owns 500 moments that
//      they own none — the failure-renders-as-data class, in copy.
//
// Also the three-star-rookie badge collapse, which exists in BOTH layouts:
// Rookie Year / Rookie Premiere / Rookie Mint are SUPPRESSED when the moment
// carries is_three_star_rookie, because the three-star pill already represents
// them. Showing both double-counts a badge collectors price on.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }))

afterEach(() => cleanup())

function row(over: Record<string, any> = {}): any {
  return {
    momentId: "m-" + (over.momentId ?? "1"),
    flowId: over.flowId ?? "f1",
    playerName: "Damian Lillard",
    setName: "Base Set",
    tier: "RARE",
    editionKey: "73:2785",
    serialNumber: 5,
    mintCount: 1000,
    fmv: 42,
    fmvConfidence: "HIGH",
    badgeInfo: null,
    parallel: null,
    subedition: null,
    editionsOwned: 1,
    editionsLocked: 0,
    ...over,
  }
}

const props = (over: Record<string, any> = {}) => ({
  isMobile: false,
  filteredRows: [row()],
  rowsCount: 1,
  summary: { totalMoments: 1 } as any,
  view: { expandedRows: {}, sortKey: "player", sortDir: "asc" } as any,
  toggleExpanded: vi.fn(),
  batchEditionStats: new Map(),
  costBasis: new Map(),
  collectionSeriesMap: new Map(),
  collectionSlug: "nba-top-shot",
  badgeCollectionId: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  connectedWallet: null,
  ownerKey: "0xabc",
  input: "0xabc",
  hasSearched: true,
  loading: false,
  showDebug: false,
  getPackCount: () => 0,
  accent: "#E03A2F",
  ...over,
})

describe("the two empty states say DIFFERENT things", () => {
  it("reports an empty wallet when there are no rows at all", () => {
    const { container } = render(
      <CollectionMomentTable {...props({ filteredRows: [], rowsCount: 0 })} />
    )
    expect(container.textContent).toContain("No moments found for this wallet")
    expect(container.textContent).not.toContain("adjusting the filters")
  })

  it("reports over-tight FILTERS when rows exist but none match", () => {
    // The collector owns 25 moments; the filter hid them. Telling them "no
    // moments found for this wallet" would be a false statement about their
    // holdings, and they would have no reason to loosen the filter.
    const { container } = render(
      <CollectionMomentTable {...props({ filteredRows: [], rowsCount: 25 })} />
    )
    expect(container.textContent).toContain("adjusting the filters")
    expect(container.textContent).not.toContain("No moments found for this wallet")
  })
})

describe("three-star rookie collapses its component badges", () => {
  const THREE_STAR = {
    is_three_star_rookie: true,
    badge_titles: ["Rookie Year", "Rookie Premiere", "Rookie Mint", "Championship Year"],
  }

  it("suppresses the three component rookie pills on DESKTOP but keeps unrelated ones", () => {
    const { container } = render(
      <CollectionMomentTable {...props({ filteredRows: [row({ badgeInfo: THREE_STAR })] })} />
    )
    const t = container.textContent ?? ""
    // The three-star pill already represents these; rendering both double-counts
    // a badge collectors price on.
    expect(t).not.toContain("Rookie Premiere")
    expect(t).not.toContain("Rookie Mint")
    // An unrelated badge is untouched by the collapse.
    expect(t).toContain("Championship Year")
  })

  it("suppresses them on MOBILE too — the second render tree has its own copy", () => {
    const { container } = render(
      <CollectionMomentTable
        {...props({ isMobile: true, filteredRows: [row({ badgeInfo: THREE_STAR })] })}
      />
    )
    const t = container.textContent ?? ""
    expect(t).not.toContain("Rookie Premiere")
    expect(t).not.toContain("Rookie Mint")
    expect(t).toContain("Championship Year")
  })

  it("shows the component rookie badges when the moment is NOT three-star", () => {
    // The mirror case — without it the suppression test would pass against a
    // component that never renders these pills at all.
    const { container } = render(
      <CollectionMomentTable
        {...props({
          filteredRows: [
            row({ badgeInfo: { is_three_star_rookie: false, badge_titles: ["Rookie Year", "Rookie Mint"] } }),
          ],
        })}
      />
    )
    const t = container.textContent ?? ""
    expect(t).toContain("Rookie Year")
    expect(t).toContain("Rookie Mint")
  })
})

describe("mobile card layout", () => {
  it("renders the card tree with player, tier and serial", () => {
    const { container } = render(
      <CollectionMomentTable {...props({ isMobile: true })} />
    )
    const t = container.textContent ?? ""
    expect(t).toContain("Damian Lillard")
    expect(t).toContain("RARE")
    expect(t).toContain("#5")
  })

  it("renders a thumbnail when one resolves, and omits the <img> when it does not", () => {
    const withThumb = render(
      <CollectionMomentTable
        {...props({ isMobile: true, filteredRows: [row({ thumbnailUrl: "https://x/img.png" })] })}
      />
    )
    expect(withThumb.container.querySelector("img")).toBeTruthy()
    withThumb.unmount()

    const noThumb = render(
      <CollectionMomentTable
        {...props({ isMobile: true, filteredRows: [row({ thumbnailUrl: null })] })}
      />
    )
    // A broken <img src=""> would render a browser placeholder glyph in a card
    // whose whole left column is art.
    expect(noThumb.container.querySelector('img[src=""]')).toBeNull()
  })

  it("is keyboard-operable and exposes expansion state", () => {
    const toggleExpanded = vi.fn()
    const { container } = render(
      <CollectionMomentTable {...props({ isMobile: true, toggleExpanded })} />
    )
    const card = container.querySelector('[role="button"][aria-expanded]')
    expect(card).toBeTruthy()
    expect(card!.getAttribute("aria-expanded")).toBe("false")
  })

  it("reflects an expanded card via aria-expanded", () => {
    const { container } = render(
      <CollectionMomentTable
        {...props({ isMobile: true, view: { expandedRows: { "m-1": true }, sortKey: "player", sortDir: "asc" } as any })}
      />
    )
    expect(container.querySelector('[role="button"][aria-expanded="true"]')).toBeTruthy()
  })

  it("renders BOTH empty states on mobile, matching desktop", () => {
    // ⚠ Found by this test: the mobile branch was a bare `filteredRows.map()`
    // with no empty-state handling, so a phone user with no matches saw a
    // completely BLANK area — no "you own nothing here", no "loosen your
    // filters". Desktop had both messages all along. Fixed in the same change.
    const empty = render(
      <CollectionMomentTable {...props({ isMobile: true, filteredRows: [], rowsCount: 0 })} />
    )
    expect(empty.container.textContent).toContain("No moments found for this wallet")
    empty.unmount()

    const filtered = render(
      <CollectionMomentTable {...props({ isMobile: true, filteredRows: [], rowsCount: 25 })} />
    )
    expect(filtered.container.textContent).toContain("adjusting the filters")
    expect(filtered.container.textContent).not.toContain("No moments found for this wallet")
  })
})

describe("cost basis and edition counts fall back without inventing numbers", () => {
  it("uses the row's own cost basis when the costBasis map has no entry", () => {
    const { container } = render(
      <CollectionMomentTable
        {...props({
          isMobile: true,
          filteredRows: [row({ costBasis: 12.5, costBasisLabel: "Bought", acquiredAt: "2026-07-01" })],
          view: { expandedRows: { "m-1": true }, sortKey: "player", sortDir: "asc" } as any,
        })}
      />
    )
    expect(container.textContent).not.toMatch(/NaN|undefined/)
  })

  it("falls back to batchEditionStats when the row carries no edition counts", () => {
    // The row-level value wins; the batch map is the fallback. Neither may
    // produce NaN when both are absent.
    const { container } = render(
      <CollectionMomentTable
        {...props({
          filteredRows: [row({ editionsOwned: null, editionsLocked: null })],
          batchEditionStats: new Map(),
        })}
      />
    )
    expect(container.textContent).not.toMatch(/NaN|undefined/)
  })
})
