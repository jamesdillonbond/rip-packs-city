import { describe, it, expect } from "vitest"
import { computeFilteredSortedRows, type FilterSortContext } from "@/lib/collection/filter-sort"
import { initialCollectionView, type CollectionViewState } from "@/lib/collection/view-reducer"
import { normalizeSetName, buildEditionScopeKey } from "@/lib/wallet-normalize"
import type { MomentRow } from "@/lib/collection/types"

function view(over: Partial<CollectionViewState> = {}): CollectionViewState {
  return { ...initialCollectionView, ...over }
}

function ctx(over: Partial<FilterSortContext> = {}): FilterSortContext {
  return {
    collectionSeriesMap: undefined,
    duplicateEditions: new Set<string>(),
    batchEditionStats: new Map(),
    ...over,
  }
}

function row(over: Partial<MomentRow> = {}): MomentRow {
  return {
    momentId: "m",
    playerName: "LeBron James",
    setName: "Base Set",
    series: "4",
    tier: "COMMON",
    parallel: null,
    subedition: null,
    fmv: 10,
    bestOffer: null,
    lowAsk: null,
    isLocked: false,
    marketConfidence: "none",
    acquisitionMethod: null,
    officialBadges: [],
    badgeInfo: null as any,
    ...over,
  } as MomentRow
}

describe("computeFilteredSortedRows", () => {
  it("returns all rows in input order when no filter is set and the sort key is server-sortable", () => {
    const rows = [row({ momentId: "a", playerName: "Zed" }), row({ momentId: "b", playerName: "Abe" })]
    const out = computeFilteredSortedRows(rows, view({ sortKey: "fmv" }), ctx())
    expect(out.map((r) => r.momentId)).toEqual(["a", "b"]) // fmv is server-sorted → no client reorder
  })

  it("applies the player filter exactly", () => {
    const rows = [row({ momentId: "a", playerName: "LeBron James" }), row({ momentId: "b", playerName: "Steph Curry" })]
    const out = computeFilteredSortedRows(rows, view({ playerFilter: "Steph Curry" }), ctx())
    expect(out.map((r) => r.momentId)).toEqual(["b"])
  })

  it("filters set by normalizeSetName, not the raw name", () => {
    const raw = "Base Set (Series 4)"
    const rows = [row({ momentId: "a", setName: raw }), row({ momentId: "b", setName: "Other" })]
    const out = computeFilteredSortedRows(rows, view({ setFilter: normalizeSetName(raw) }), ctx())
    expect(out.map((r) => r.momentId)).toEqual(["a"])
  })

  it("honors locked / unlocked filters", () => {
    const rows = [row({ momentId: "a", isLocked: true }), row({ momentId: "b", isLocked: false })]
    expect(computeFilteredSortedRows(rows, view({ lockedFilter: "locked" }), ctx()).map((r) => r.momentId)).toEqual(["a"])
    expect(computeFilteredSortedRows(rows, view({ lockedFilter: "unlocked" }), ctx()).map((r) => r.momentId)).toEqual(["b"])
  })

  it("filterHasOffer keeps only rows with a positive best offer; filterListed needs a low ask", () => {
    const rows = [row({ momentId: "a", bestOffer: 5, lowAsk: null }), row({ momentId: "b", bestOffer: 0, lowAsk: 3 })]
    expect(computeFilteredSortedRows(rows, view({ filterHasOffer: true }), ctx()).map((r) => r.momentId)).toEqual(["a"])
    expect(computeFilteredSortedRows(rows, view({ filterListed: true }), ctx()).map((r) => r.momentId)).toEqual(["b"])
  })

  it("filterLoanDefaultsOnly and filterDupsOnly narrow correctly", () => {
    const rows = [
      row({ momentId: "a", acquisitionMethod: "loan_default" }),
      row({ momentId: "b", acquisitionMethod: "marketplace" }),
    ]
    expect(computeFilteredSortedRows(rows, view({ filterLoanDefaultsOnly: true }), ctx()).map((r) => r.momentId)).toEqual(["a"])

    // Dups: only rows whose duplicateGroupKey is in the provided set survive.
    // buildEditionScopeKey-independent — duplicateGroupKey is internal, so build
    // the set by asking the function itself which keys exist is circular; instead
    // verify the gate is applied: an empty dup set drops everything.
    expect(computeFilteredSortedRows(rows, view({ filterDupsOnly: true }), ctx({ duplicateEditions: new Set() }))).toHaveLength(0)
  })

  it("free-text search matches across player/set/tier/traits", () => {
    const rows = [
      row({ momentId: "a", playerName: "LeBron James", setName: "Base Set" }),
      row({ momentId: "b", playerName: "Steph Curry", setName: "Holo" }),
    ]
    expect(computeFilteredSortedRows(rows, view({ searchWithin: "lebron" }), ctx()).map((r) => r.momentId)).toEqual(["a"])
    expect(computeFilteredSortedRows(rows, view({ searchWithin: "holo" }), ctx()).map((r) => r.momentId)).toEqual(["b"])
    expect(computeFilteredSortedRows(rows, view({ searchWithin: "zzz" }), ctx())).toHaveLength(0)
  })

  it("client-sorts by player asc/desc for a non-server-sortable key", () => {
    const rows = [row({ momentId: "a", playerName: "Zed" }), row({ momentId: "b", playerName: "Abe" })]
    expect(computeFilteredSortedRows(rows, view({ sortKey: "player", sortDirection: "asc" }), ctx()).map((r) => r.playerName)).toEqual(["Abe", "Zed"])
    expect(computeFilteredSortedRows(rows, view({ sortKey: "player", sortDirection: "desc" }), ctx()).map((r) => r.playerName)).toEqual(["Zed", "Abe"])
  })

  it("client-sorts by bestOffer numerically", () => {
    const rows = [row({ momentId: "a", bestOffer: 3 }), row({ momentId: "b", bestOffer: 9 }), row({ momentId: "c", bestOffer: null })]
    const asc = computeFilteredSortedRows(rows, view({ sortKey: "bestOffer", sortDirection: "asc" }), ctx())
    // null sorts as the smallest via compareNumber; 3 before 9.
    expect(asc.map((r) => r.bestOffer)).toEqual([null, 3, 9])
  })

  it("held-sort falls back from editionsOwned to batchEditionStats", () => {
    const a = row({ momentId: "a", editionsOwned: 2 } as any)
    const b = row({ momentId: "b" }) // no editionsOwned → read from the stats map
    const stats = new Map([[buildEditionScopeKey(b), { owned: 9, locked: 0 }]])
    const out = computeFilteredSortedRows([a, b], view({ sortKey: "held", sortDirection: "desc" }), ctx({ batchEditionStats: stats }))
    expect(out.map((r) => r.momentId)).toEqual(["b", "a"]) // 9 > 2
  })

  it("does not mutate the input array", () => {
    const rows = [row({ momentId: "a", playerName: "Zed" }), row({ momentId: "b", playerName: "Abe" })]
    const before = rows.map((r) => r.momentId)
    computeFilteredSortedRows(rows, view({ sortKey: "player", sortDirection: "asc" }), ctx())
    expect(rows.map((r) => r.momentId)).toEqual(before)
  })

  // ── remaining filter arms (series / rarity / badge / filterBadges) ──────────
  it("filters by the series label, not the raw series int", () => {
    // seriesFilterLabel maps "4" → "Series 3" via the Top Shot fallback map, so a
    // filter keyed on the display label must match the row whose raw series is "4".
    const rows = [row({ momentId: "a", series: "4" }), row({ momentId: "b", series: "2" })]
    const out = computeFilteredSortedRows(rows, view({ seriesFilter: "Series 3" }), ctx())
    expect(out.map((r) => r.momentId)).toEqual(["a"])
  })

  it("applies the rarity (tier) filter exactly", () => {
    const rows = [row({ momentId: "a", tier: "LEGENDARY" }), row({ momentId: "b", tier: "COMMON" })]
    const out = computeFilteredSortedRows(rows, view({ rarityFilter: "LEGENDARY" }), ctx())
    expect(out.map((r) => r.momentId)).toEqual(["a"])
  })

  it("badgeFilter keeps only rows with a positive badge_score", () => {
    const rows = [
      row({ momentId: "a", badgeInfo: { badge_score: 12 } as any }),
      row({ momentId: "b", badgeInfo: { badge_score: 0 } as any }),
      row({ momentId: "c" }), // no badgeInfo at all
    ]
    const out = computeFilteredSortedRows(rows, view({ badgeFilter: true }), ctx())
    expect(out.map((r) => r.momentId)).toEqual(["a"])
  })

  it("filterBadges keeps rows with an official badge OR a positive badgeScore", () => {
    const rows = [
      row({ momentId: "a", officialBadges: ["Rookie Year"] }),
      row({ momentId: "b", officialBadges: [], ...( { badgeScore: 3 } as any) }),
      row({ momentId: "c", officialBadges: [] }),
    ]
    const out = computeFilteredSortedRows(rows, view({ filterBadges: true }), ctx())
    expect(out.map((r) => r.momentId).sort()).toEqual(["a", "b"])
  })

  // ── remaining client-sort comparator arms ───────────────────────────────────
  it("client-sorts by series/set text", () => {
    const bySeries = computeFilteredSortedRows(
      [row({ momentId: "a", series: "8" }), row({ momentId: "b", series: "2" })],
      view({ sortKey: "series", sortDirection: "asc" }),
      ctx(),
    )
    expect(bySeries.map((r) => r.momentId)).toEqual(["b", "a"]) // "2" < "8"
    const bySet = computeFilteredSortedRows(
      [row({ momentId: "a", setName: "Zephyr" }), row({ momentId: "b", setName: "Alpha" })],
      view({ sortKey: "set", sortDirection: "asc" }),
      ctx(),
    )
    expect(bySet.map((r) => r.momentId)).toEqual(["b", "a"])
  })

  it("client-sorts by parallel and rarity text", () => {
    const byParallel = computeFilteredSortedRows(
      [row({ momentId: "a", parallel: "Hexwave" }), row({ momentId: "b", parallel: "Aurora" })],
      view({ sortKey: "parallel", sortDirection: "asc" }),
      ctx(),
    )
    expect(byParallel.map((r) => r.momentId)).toEqual(["b", "a"])
    const byRarity = computeFilteredSortedRows(
      [row({ momentId: "a", tier: "RARE" }), row({ momentId: "b", tier: "COMMON" })],
      view({ sortKey: "rarity", sortDirection: "asc" }),
      ctx(),
    )
    expect(byRarity.map((r) => r.momentId)).toEqual(["b", "a"]) // "COMMON" < "RARE"
  })

  it("client-sorts by badge_score numerically (nulls sort smallest)", () => {
    const rows = [
      row({ momentId: "a", badgeInfo: { badge_score: 5 } as any }),
      row({ momentId: "b", badgeInfo: { badge_score: 20 } as any }),
      row({ momentId: "c" }), // no badgeInfo → treated as -Infinity
    ]
    const out = computeFilteredSortedRows(rows, view({ sortKey: "badge", sortDirection: "desc" }), ctx())
    expect(out.map((r) => r.momentId)).toEqual(["b", "a", "c"])
  })
})
