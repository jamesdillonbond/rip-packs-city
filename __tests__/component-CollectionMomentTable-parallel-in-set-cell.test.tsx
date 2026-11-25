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
  // The table carries the binder class its width rule keys on (app/rpc-tokens.css, 2026-11-24).
  it("the table carries rpc-table--binder", () => {
    const { container } = render(<CollectionMomentTable {...props(row())} />)
    expect(container.querySelector("table.rpc-table.rpc-table--binder")).not.toBeNull()
  })
})

// The rule that makes the 13-column table fit laptop widths must keep both arms and out-rank the
// generic .rpc-table cell padding (16 px), which is defined later in the same file.
describe("binder table width rule in app/rpc-tokens.css", () => {
  it("keeps the 12 px default and the 8 px below-1536 arm, at two-class specificity", async () => {
    const { readFileSync } = await import("node:fs")
    const css = readFileSync("app/rpc-tokens.css", "utf8")
    expect(css).toMatch(/\.rpc-table\.rpc-table--binder th, \.rpc-table\.rpc-table--binder td \{ padding-left: 12px; padding-right: 12px; \}/)
    expect(css).toMatch(/@media \(max-width: 1535px\) \{\s*\.rpc-table\.rpc-table--binder th, \.rpc-table\.rpc-table--binder td \{ padding-left: 8px; padding-right: 8px; \}/)
  })
})
