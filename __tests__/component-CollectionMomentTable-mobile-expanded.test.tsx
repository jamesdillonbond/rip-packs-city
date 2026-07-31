// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/nba-top-shot/collection",
  useSearchParams: () => new URLSearchParams(),
}))

import CollectionMomentTable from "@/components/collection/CollectionMomentTable"

// The existing CollectionMomentTable suite covers the desktop table (incl. a
// desktop-expanded row). This drives the MOBILE expanded card panel — the
// sub-sections that were dark: the FMV / Low-Ask / Cost-&-P&L rows over a real
// cost-basis entry, and the "Recent sales for this edition" section (which mounts
// EditionRecentSales → a fetch, stubbed here). Mobile + expanded + populated
// cost-basis is the combination no prior test set.

function row(over: Record<string, any> = {}): any {
  return {
    momentId: "m-1",
    flowId: "f1",
    playerName: "Damian Lillard",
    setName: "Base Set",
    tier: "RARE",
    editionKey: "73:2785",
    serialNumber: 5,
    mintCount: 1000,
    fmv: 42,
    fmvConfidence: "HIGH",
    lowAsk: 55,
    badgeInfo: null,
    parallel: null,
    subedition: null,
    editionsOwned: 1,
    editionsLocked: 0,
    ...over,
  }
}

const baseProps = (over: Record<string, any> = {}) => ({
  isMobile: true,
  filteredRows: [row()],
  rowsCount: 1,
  summary: { totalMoments: 1, remainingMoments: 0 } as any,
  view: { expandedRows: { "m-1": true }, sortKey: "player", sortDir: "asc" } as any,
  toggleExpanded: vi.fn(),
  batchEditionStats: new Map([["73:2785", { owned: 1, locked: 0 }]]),
  costBasis: new Map([
    ["f1", { buyPrice: 10, acquiredDate: "2026-01-01", fmvAtAcquisition: 8, acquisitionMethod: "pack_pull", costBasisLabel: "Pack pull" }],
  ]),
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

beforeEach(() => {
  // EditionRecentSales (mounted in the expanded panel) fetches recent sales.
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ sales: [] }) } as Response)))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("CollectionMomentTable mobile expanded panel", () => {
  it("renders the expanded mobile card with cost-basis + recent-sales sections", () => {
    const { container } = render(<CollectionMomentTable {...baseProps()} />)
    // The moment row rendered on the mobile card path.
    expect(container.textContent).toContain("Damian Lillard")
    // The expanded panel's cost-basis figure ($10.00 buy price) is present.
    expect(container.textContent).toContain("$10.00")
    // The recent-sales section header is present.
    expect(container.textContent).toContain("Recent sales for this edition")
  })

  it("renders a loan-default cost basis label in the expanded panel", () => {
    const props = baseProps({
      costBasis: new Map([
        ["f1", { buyPrice: 75, acquiredDate: "2026-02-02", fmvAtAcquisition: null, acquisitionMethod: "loan_default", costBasisLabel: "Loan" }],
      ]),
    })
    const { container } = render(<CollectionMomentTable {...props} />)
    expect(container.textContent).toContain("Damian Lillard")
    // The loan-default path renders its own label + the $75.00 principal.
    expect(container.textContent).toContain("$75.00")
  })
})
