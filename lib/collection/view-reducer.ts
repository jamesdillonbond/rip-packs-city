// View-state reducer for the wallet-collection viewer
// (app/(collections)/[collection]/collection/page.tsx). Behavior-preserving
// extraction of the filter/sort/view controls into a single reducer so the
// filter bar + moment table can be lifted into presentational children with a
// small {view, dispatchView} prop surface. DATA/fetch state stays as useState
// in the page — only VIEW controls live here.
import type { LeagueValue } from "@/components/filters/LeagueFilter"
import type { SortKey, MomentRow } from "@/lib/collection/types"

export interface CollectionViewState {
  playerFilter: string
  setFilter: string
  seriesFilter: string
  rarityFilter: string
  lockedFilter: string
  leagueFilter: LeagueValue
  searchWithin: string
  sortKey: SortKey
  sortDirection: "asc" | "desc"
  filterBadges: boolean
  badgeFilter: boolean
  filterHasOffer: boolean
  filterListed: boolean
  filterLoanDefaultsOnly: boolean
  filterDupsOnly: boolean
  dupDismissed: boolean
  expandedRows: Record<string, boolean>
  selectedMoment: MomentRow | null
}

export const initialCollectionView: CollectionViewState = {
  playerFilter: "all", setFilter: "all", seriesFilter: "all", rarityFilter: "all",
  lockedFilter: "all", leagueFilter: "all", searchWithin: "",
  sortKey: "fmv", sortDirection: "desc",
  filterBadges: false, badgeFilter: false, filterHasOffer: false, filterListed: false,
  filterLoanDefaultsOnly: false, filterDupsOnly: false, dupDismissed: false,
  expandedRows: {}, selectedMoment: null,
}

export type CollectionViewAction =
  // one generic setter keeps the action union small; keyof gives compile-time
  // safety that field + value match.
  | { [K in keyof CollectionViewState]: { type: "SET"; field: K; value: CollectionViewState[K] } }[keyof CollectionViewState]
  | { type: "TOGGLE_SORT_DIR" }
  | { type: "SET_SORT"; key: SortKey; direction?: "asc" | "desc" }
  | { type: "TOGGLE_EXPANDED"; id: string }
  | { type: "COLLAPSE_ALL" }
  | { type: "SELECT_MOMENT"; moment: MomentRow | null }
  | { type: "RESET_FILTERS" }

export function collectionViewReducer(
  s: CollectionViewState, a: CollectionViewAction,
): CollectionViewState {
  switch (a.type) {
    case "SET": return { ...s, [a.field]: a.value }
    case "TOGGLE_SORT_DIR": return { ...s, sortDirection: s.sortDirection === "asc" ? "desc" : "asc" }
    case "SET_SORT": return { ...s, sortKey: a.key, sortDirection: a.direction ?? s.sortDirection }
    case "TOGGLE_EXPANDED": return { ...s, expandedRows: { ...s.expandedRows, [a.id]: !s.expandedRows[a.id] } }
    case "COLLAPSE_ALL": return { ...s, expandedRows: {} }
    case "SELECT_MOMENT": return { ...s, selectedMoment: a.moment }
    case "RESET_FILTERS": return {
      ...s, playerFilter: "all", setFilter: "all", seriesFilter: "all", rarityFilter: "all",
      lockedFilter: "all", leagueFilter: "all", searchWithin: "",
      filterBadges: false, badgeFilter: false, filterHasOffer: false, filterListed: false,
      filterLoanDefaultsOnly: false, filterDupsOnly: false,
    }
    default: return s
  }
}
