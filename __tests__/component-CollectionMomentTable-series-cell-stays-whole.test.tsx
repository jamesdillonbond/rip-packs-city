// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/nba-top-shot/collection",
  useSearchParams: () => new URLSearchParams(),
}))

import CollectionMomentTable from "@/components/collection/CollectionMomentTable"

// 2026-11-24 (Trevor: "the series seems to be off on the clingan and others"): the desktop
// table's Series cell read "Series 2024-25 · 2024-25" and wrapped over three lines. The label
// no longer repeats its season, and each part stays whole; the only allowed break is before
// the season of an older series ("Series 1 / 2019-20").
const map = new Map<number, any>([
  [0, { series_number: 0, display_label: "Series 1", season: "2019-20" }],
  [7, { series_number: 7, display_label: "Series 2024-25", season: "2024-25" }],
])
const row = (series: string) => ({ momentId: "m" + series, flowId: "f" + series, playerName: "Donovan Clingan", setName: "2024 Rookie Ultimates", tier: "ULTIMATE", editionKey: "176:7003", serial: 1, mintSize: 1, fmv: 2100, series, badgeInfo: null, editionsOwned: 1, editionsLocked: 1 })
const props = (r: any) => ({
  isMobile: false, filteredRows: [r], rowsCount: 1, summary: { totalMoments: 1, remainingMoments: 0 } as any,
  view: { expandedRows: {}, sortKey: "fmv", sortDir: "desc" } as any, toggleExpanded: vi.fn(), batchEditionStats: new Map(),
  costBasis: new Map(), collectionSeriesMap: map, collectionSlug: "nba-top-shot", badgeCollectionId: "x", connectedWallet: null,
  ownerKey: "0xabc", input: "0xabc", hasSearched: true, loading: false, showDebug: false, getPackCount: null, accent: "#E03A2F",
})
afterEach(cleanup)

const seriesSpans = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("td span.whitespace-nowrap")).map((s) => s.textContent!.trim()).filter((t) => /Series|\d{4}-\d{2}/.test(t))

describe("desktop table Series cell", () => {
  it("a label that carries its season renders once, as one unbreakable piece", () => {
    const { container } = render(<CollectionMomentTable {...props(row("7"))} />)
    expect(container.textContent).not.toContain("2024-25 · 2024-25")
    expect(seriesSpans(container)).toEqual(["Series 2024-25"])
  })
  it("an older series keeps its season, breakable only before it", () => {
    const { container } = render(<CollectionMomentTable {...props(row("0"))} />)
    expect(seriesSpans(container)).toEqual(["Series 1", "· 2019-20"])
  })
})
