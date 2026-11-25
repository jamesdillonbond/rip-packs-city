// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/nba-top-shot/collection",
  useSearchParams: () => new URLSearchParams(),
}))

import CollectionMomentTable from "@/components/collection/CollectionMomentTable"

// 2026-11-24: the desktop table's Parallel column read "Base" on nearly every row and pushed the
// table past 1280 px. The column is gone; a parallel is named under the set name, and ONLY on a
// row that is one — a base Moment shows nothing, never a "Base" tag.
const row = (over: Record<string, unknown> = {}) => ({ momentId: "m1", flowId: "f1", playerName: "Donovan Clingan", setName: "Base Set", tier: "COMMON", editionKey: "2:10", serial: 5, mintSize: 100, fmv: 3, series: "7", badgeInfo: null, editionsOwned: 1, editionsLocked: 0, ...over })
const props = (r: any) => ({
  isMobile: false, filteredRows: [r], rowsCount: 1, summary: { totalMoments: 1, remainingMoments: 0 } as any,
  view: { expandedRows: {}, sortKey: "fmv", sortDir: "desc" } as any, toggleExpanded: vi.fn(), batchEditionStats: new Map(),
  costBasis: new Map(), collectionSeriesMap: new Map(), collectionSlug: "nba-top-shot", badgeCollectionId: "x", connectedWallet: null,
  ownerKey: "0xabc", input: "0xabc", hasSearched: true, loading: false, showDebug: false, getPackCount: null, accent: "#E03A2F",
})
afterEach(cleanup)

describe("desktop table — parallel lives in the Set cell", () => {
  it("has no Parallel column", () => {
    render(<CollectionMomentTable {...props(row())} />)
    expect(screen.queryByRole("columnheader", { name: /^parallel$/i })).toBeNull()
  })
  it("names a parallel under the set name", () => {
    render(<CollectionMomentTable {...props(row({ parallel: "Holo Icon" }))} />)
    expect(screen.getByTestId("set-parallel").textContent).toBe("Holo Icon")
  })
  it("a base Moment shows no tag at all", () => {
    render(<CollectionMomentTable {...props(row())} />)
    expect(screen.queryByTestId("set-parallel")).toBeNull()
  })
})
