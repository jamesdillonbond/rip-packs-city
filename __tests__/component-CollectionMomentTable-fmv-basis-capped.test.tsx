// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/nba-top-shot/collection",
  useSearchParams: () => new URLSearchParams(),
}))

import CollectionMomentTable from "@/components/collection/CollectionMomentTable"

// #215 (2026-10-29): an ASK_ONLY FMV capped at its edition's own sales (`fmvCapped`, from
// wallet-search's algo_version) reads "capped at sales" — never "from asks", whose tooltip
// says the edition has no corroborating sales. An unknown flag keeps "from asks".

function row(over: Record<string, any> = {}): any {
  return {
    momentId: "m-1",
    flowId: "f1",
    playerName: "Damian Lillard",
    setName: "Base Set",
    tier: "LEGENDARY",
    editionKey: "73:2785",
    serialNumber: 5,
    mintCount: 28,
    fmv: 42,
    badgeInfo: null,
    editionsOwned: 1,
    editionsLocked: 0,
    ...over,
  }
}

const props = (r: any, slug = "nba-top-shot") => ({
  isMobile: true,
  filteredRows: [r],
  rowsCount: 1,
  summary: { totalMoments: 1, remainingMoments: 0 } as any,
  view: { expandedRows: {}, sortKey: "fmv", sortDir: "desc" } as any,
  toggleExpanded: vi.fn(),
  batchEditionStats: new Map(),
  costBasis: new Map(),
  collectionSeriesMap: new Map(),
  collectionSlug: slug,
  badgeCollectionId: "x",
  connectedWallet: null,
  ownerKey: "0xabc",
  input: "0xabc",
  hasSearched: true,
  loading: false,
  showDebug: false,
  getPackCount: () => 0,
  accent: "#E03A2F",
})

afterEach(cleanup)

describe("collection table — FMV basis marker", () => {
  for (const isMobile of [true, false]) {
    it(`${isMobile ? "mobile" : "desktop"}: a capped ASK_ONLY row reads 'capped at sales', not 'from asks'`, () => {
      const { container } = render(
        <CollectionMomentTable {...props(row({ marketConfidence: "ask_only", fmvCapped: true }))} isMobile={isMobile} />,
      )
      expect(container.textContent).toContain("capped at sales")
      expect(container.textContent).not.toContain("from asks")
    })

    it(`${isMobile ? "mobile" : "desktop"}: an uncapped (or unknown) ASK_ONLY row keeps 'from asks'`, () => {
      const { container } = render(
        <CollectionMomentTable {...props(row({ marketConfidence: "ask_only", fmvCapped: null }))} isMobile={isMobile} />,
      )
      expect(container.textContent).toContain("from asks")
      expect(container.textContent).not.toContain("capped at sales")
    })
  }
})
