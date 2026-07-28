// lib/collection/filter-sort.ts
//
// Pure filter + sort for the collection page's moment table — "which rows show,
// in what order". Extracted verbatim from the `filteredRows` useMemo in
// app/(collections)/[collection]/collection/page.tsx (monolith Phase-2 slice)
// so the filter branches and the client-sort comparator ladder are a
// standalone, unit-tested surface. Deterministic given (rows, view, ctx); the
// server-sortable columns (fmv/serial/acquired/paid) are already ordered by the
// API and are intentionally left untouched here.

import { normalizeSetName, buildEditionScopeKey } from "@/lib/wallet-normalize"
import {
  seriesFilterLabel,
  getLocked,
  duplicateGroupKey,
  getParallel,
  getTraits,
  compareText,
  compareNumber,
} from "@/lib/collection/helpers"
import type { MomentRow, SortKey, CollectionSeriesEntry } from "@/lib/collection/types"
import type { CollectionViewState } from "@/lib/collection/view-reducer"

export interface FilterSortContext {
  collectionSeriesMap?: Map<number, CollectionSeriesEntry>
  duplicateEditions: Set<string>
  batchEditionStats: Map<string, { owned: number; locked: number }>
}

// Columns the API already sorted — skip the client re-sort for these.
const SERVER_SORTABLE_KEYS: SortKey[] = ["fmv", "serial", "acquired", "paid"]

export function computeFilteredSortedRows(
  rows: MomentRow[],
  view: CollectionViewState,
  ctx: FilterSortContext,
): MomentRow[] {
  const { collectionSeriesMap, duplicateEditions, batchEditionStats } = ctx
  const q = view.searchWithin.trim().toLowerCase()
  const filtered = rows.filter(function (r) {
    if (view.playerFilter !== "all" && r.playerName !== view.playerFilter) return false
    if (view.setFilter !== "all" && normalizeSetName(r.setName) !== view.setFilter) return false
    if (view.seriesFilter !== "all" && seriesFilterLabel(r.series, collectionSeriesMap) !== view.seriesFilter) return false
    if (view.rarityFilter !== "all" && r.tier !== view.rarityFilter) return false
    if (view.lockedFilter === "locked" && !getLocked(r)) return false
    if (view.lockedFilter === "unlocked" && getLocked(r)) return false
    if (view.badgeFilter && !r.badgeInfo?.badge_score) return false
    if (view.filterBadges && !(r.officialBadges?.length || (r as any).badgeScore > 0)) return false
    if (view.filterHasOffer && !(typeof r.bestOffer === "number" && r.bestOffer > 0)) return false
    if (view.filterListed && r.lowAsk == null) return false
    if (view.filterLoanDefaultsOnly && r.acquisitionMethod !== "loan_default") return false
    if (view.filterDupsOnly) {
      const key = duplicateGroupKey(r)
      if (!duplicateEditions.has(key)) return false
    }
    if (q) {
      const haystack = [r.playerName, r.team ?? "", r.league ?? "", r.series ?? "", r.setName, getParallel(r), r.tier ?? "", ...(r.officialBadges ?? []), ...(r.badgeInfo?.badge_titles ?? []), ...getTraits(r)].join(" ").toLowerCase()
      if (!haystack.includes(q)) return false
    }
    return true
  })

  // Only apply client-side sort for non-server-sortable columns.
  if (!SERVER_SORTABLE_KEYS.includes(view.sortKey)) {
    filtered.sort(function (a, b) {
      let result = 0
      switch (view.sortKey) {
        case "player":    result = compareText(a.playerName, b.playerName); break
        case "series":    result = compareText(a.series, b.series); break
        case "set":       result = compareText(a.setName, b.setName); break
        case "parallel":  result = compareText(getParallel(a), getParallel(b)); break
        case "rarity":    result = compareText(a.tier, b.tier); break
        case "bestOffer": result = compareNumber(a.bestOffer, b.bestOffer); break
        case "badge":     result = compareNumber(a.badgeInfo?.badge_score, b.badgeInfo?.badge_score); break
        case "held":
          result = compareNumber(
            a.editionsOwned ?? batchEditionStats.get(buildEditionScopeKey(a))?.owned,
            b.editionsOwned ?? batchEditionStats.get(buildEditionScopeKey(b))?.owned
          ); break
      }
      return view.sortDirection === "asc" ? result : -result
    })
  }
  return filtered
}
