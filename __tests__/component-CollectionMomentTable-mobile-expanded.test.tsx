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
  // ⚠ This fixture used to pair acquisitionMethod "pack_pull" with
  // costBasisLabel "Pack pull". That label does not exist: ACQUISITION_METHOD_LABEL
  // in lib/analytics/shape.ts maps pack_pull -> "Pack", and the whole vocabulary is
  // Bought | Pack | Loan | Gift | Reward | Airdrop | null. "Pack pull" therefore
  // matched no chip branch and fell through to the generic cost path, so the test
  // asserted a code path real data never reaches — the same
  // passing-test-on-an-impossible-fixture shape deep-audit D9 recorded. A real
  // "Pack" renders the PACK chip and NO cost figure (a pack pull has no purchase
  // price). Switched to "Bought", which genuinely does show a cost figure, so the
  // assertion below keeps its meaning.
  costBasis: new Map([
    ["f1", { buyPrice: 10, acquiredDate: "2026-01-01", fmvAtAcquisition: 8, acquisitionMethod: "marketplace", costBasisLabel: "Bought" }],
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

// Mobile-card branches the two suites above don't reach: the Gift/Reward/Airdrop
// cost chips (mobile draws its own set), the serial-fmv / stale-fmv row cells, and
// the "showing N of M — open on desktop" overflow banner.
describe("CollectionMomentTable mobile — cost chips / serial-fmv / overflow banner", () => {
  const chipProps = (label: string) =>
    baseProps({
      view: { expandedRows: {}, sortKey: "player", sortDir: "asc" } as any,
      costBasis: new Map([
        ["f1", { buyPrice: 0, acquiredDate: "2026-01-01", fmvAtAcquisition: null, acquisitionMethod: null, costBasisLabel: label }],
      ]),
    })

  it("renders the Gift cost chip on the mobile card", () => {
    const { container } = render(<CollectionMomentTable {...chipProps("Gift")} />)
    expect(container.textContent).toContain("GIFT")
  })

  it("renders the Reward cost chip on the mobile card", () => {
    const { container } = render(<CollectionMomentTable {...chipProps("Reward")} />)
    expect(container.textContent).toContain("REWARD")
  })

  it("renders the Airdrop cost chip on the mobile card", () => {
    const { container } = render(<CollectionMomentTable {...chipProps("Airdrop")} />)
    expect(container.textContent).toContain("AIRDROP")
  })

  it("renders a serial-fmv badge and a stale FMV on the mobile card", () => {
    const props = baseProps({
      view: { expandedRows: {}, sortKey: "player", sortDir: "asc" } as any,
      filteredRows: [
        {
          momentId: "m-1",
          flowId: "f1",
          playerName: "Damian Lillard",
          setName: "Base Set",
          tier: "RARE",
          editionKey: "73:2785",
          serialNumber: 5,
          mintCount: 1000,
          fmv: 42,
          marketConfidence: "stale",
          serialFmv: { estimate_usd: 5000, multiplier: 3, serial_bucket: "first" },
          badgeInfo: null,
          parallel: null,
          subedition: null,
          editionsOwned: 1,
          editionsLocked: 0,
        } as any,
      ],
    })
    const { container } = render(<CollectionMomentTable {...props} />)
    expect(container.textContent).toContain("#1 est")
    // stale FMV carries the "no sales in 30+ days" title
    expect(container.querySelector('[title="No sales in 30+ days — FMV may be inaccurate"]')).toBeTruthy()
  })

  it("shows the desktop-overflow banner when more moments remain", () => {
    const props = baseProps({
      view: { expandedRows: {}, sortKey: "player", sortDir: "asc" } as any,
      summary: { totalMoments: 500, remainingMoments: 480 } as any,
    })
    const { container } = render(<CollectionMomentTable {...props} />)
    expect(container.textContent).toContain("open on desktop for full collection")
  })
})
