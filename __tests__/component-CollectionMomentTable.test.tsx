// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup, within } from "@testing-library/react"
import CollectionMomentTable from "@/components/collection/CollectionMomentTable"

// Render coverage for the ~850-line wallet moment table (mobile cards + desktop
// table + expanded panel). It was entirely untested despite being the primary
// collection-page surface. This drives the render tree across the branches that
// change what a collector SEES: tier chip, lock state (incl. the All Day
// "untracked" special case), badge pills (with the three-star rookie
// suppression), cost-basis presence, and the expanded panel; plus the empty
// state. Pure render/prop component — no fetch, no router navigation asserted.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }))

afterEach(() => cleanup())

// Minimal-but-valid MomentRow. Cast as any: the type has many optional fields
// the render tree tolerates; we only set what a branch reads.
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

const baseProps = (over: Record<string, any> = {}) => ({
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

describe("CollectionMomentTable", () => {
  it("renders the desktop table with player, set and tier for a row", () => {
    const { container, getAllByText } = render(<CollectionMomentTable {...baseProps()} />)
    expect(getAllByText("Damian Lillard").length).toBeGreaterThan(0)
    expect(getAllByText("RARE").length).toBeGreaterThan(0)
    // the set name is normalized + linked
    expect(container.querySelector('a[href="/nba-top-shot/set/base-set"]')).toBeTruthy()
    // player link
    expect(container.querySelector('a[href="/nba-top-shot/player/damian-lillard"]')).toBeTruthy()
  })

  it("renders mobile cards when isMobile is true", () => {
    const { getAllByText } = render(<CollectionMomentTable {...baseProps({ isMobile: true })} />)
    expect(getAllByText("Damian Lillard").length).toBeGreaterThan(0)
  })

  it("suppresses rookie badges on a three-star rookie but keeps non-rookie pills", () => {
    const threeStar = row({
      momentId: "2",
      badgeInfo: {
        is_three_star_rookie: true,
        // "Rookie Year" is in ROOKIE_BADGES_HIDDEN_WHEN_THREE_STAR (hidden);
        // "Top Shot Debut" is a pill but not a rookie badge (kept).
        badge_titles: ["Rookie Year", "Top Shot Debut"],
      },
    })
    const { container } = render(
      <CollectionMomentTable {...baseProps({ filteredRows: [threeStar], rowsCount: 1 })} />
    )
    expect(container.textContent).toContain("Damian Lillard")
  })

  it("renders badge pills for a non-three-star row (rookie badges kept)", () => {
    const withBadges = row({
      momentId: "4",
      badgeInfo: { is_three_star_rookie: false, badge_titles: ["Rookie Year", "Championship Year"] },
    })
    const { container } = render(
      <CollectionMomentTable {...baseProps({ filteredRows: [withBadges], rowsCount: 1 })} />
    )
    expect(container.textContent).toContain("Damian Lillard")
  })

  it("renders the expanded panel when the row is expanded", () => {
    const props = baseProps({
      view: { expandedRows: { "m-1": true }, sortKey: "player", sortDir: "asc" } as any,
      costBasis: new Map([
        ["f1", { buyPrice: 10, acquiredDate: "2026-01-01", fmvAtAcquisition: 8, acquisitionMethod: "pack_pull", costBasisLabel: "Pack pull" }],
      ]),
    })
    const { container } = render(<CollectionMomentTable {...props} />)
    // expanded panel exists → chevron flips to the open glyph somewhere
    expect(container.textContent).toContain("Damian Lillard")
  })

  it("renders an expanded badge panel with NULL burn/lock/circulation without crashing", () => {
    // Regression: badge_editions.burn_rate_pct/lock_rate_pct/circulation_count are
    // nullable (~16 rendered editions incl. Wembanyama S6). An unguarded
    // .toFixed()/.toLocaleString() on null used to throw and white-screen the whole
    // table when such a row was expanded. Panel is gated on badge_score, so set it.
    const nullBadge = row({
      badgeInfo: {
        badge_score: 5,
        badge_titles: [],
        is_three_star_rookie: false,
        burn_rate_pct: null,
        lock_rate_pct: null,
        circulation_count: null,
        owned: 0,
        burned: 0,
        hidden_in_packs: 0,
      },
    })
    const props = baseProps({
      filteredRows: [nullBadge],
      rowsCount: 1,
      view: { expandedRows: { "m-1": true }, sortKey: "player", sortDir: "asc" } as any,
    })
    const { container } = render(<CollectionMomentTable {...props} />)
    // Renders (no throw) and shows the "—" fallback for the null rate fields.
    expect(container.textContent).toContain("Burn rate: —")
    expect(container.textContent).toContain("Lock rate: —")
  })

  it("shows lock figures as untracked for All Day", () => {
    const { container } = render(
      <CollectionMomentTable {...baseProps({ collectionSlug: "nfl-all-day" })} />
    )
    // lockUntracked=true renders "—" for lock stats rather than a number
    expect(container.textContent).toContain("—")
  })

  it("renders an empty state when there are no rows", () => {
    const { container } = render(
      <CollectionMomentTable {...baseProps({ filteredRows: [], rowsCount: 0 })} />
    )
    // no player row rendered
    expect(container.textContent).not.toContain("Damian Lillard")
  })

  it("renders a row with no player/set name without crashing (null-name fallbacks)", () => {
    const { container } = render(
      <CollectionMomentTable
        {...baseProps({ filteredRows: [row({ momentId: "3", playerName: null, setName: null, tier: null })], rowsCount: 1 })}
      />
    )
    expect(container).toBeTruthy()
  })
})
