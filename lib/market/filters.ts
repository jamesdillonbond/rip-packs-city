// Pure filter/derive helpers for the Market page (app/(collections)/[collection]/
// market/page.tsx — a ~1,180-line client monolith neither coverage gate measures).
// Bodies are byte-identical to the page's useMemo blocks; the page imports these.
//
// Structural input types (only the fields the logic reads) keep this module
// self-contained.

export type OwnedFilter = "all" | "owned" | "not_owned"

/** Edition ownership counts keyed by editionKey. */
export type EditionStats = Map<string, { owned: number; locked?: number }>

/** Minimal listing shape the owned-filter reads. */
export interface OwnedFilterable {
  editionKey: string | null
}

/** Apply the client-side Owned / Not-owned filter. When the filter is "all",
 * the owner isn't known, or we have no edition counts yet, the list passes
 * through untouched. */
export function filterListingsByOwned<L extends OwnedFilterable>(
  listings: L[],
  ownedFilter: OwnedFilter,
  ownerKey: string | null,
  editionStats: EditionStats,
): L[] {
  if (ownedFilter === "all" || !ownerKey || editionStats.size === 0) return listings
  return listings.filter((l) => {
    const stats = l.editionKey ? editionStats.get(l.editionKey) : null
    const owned = stats != null && stats.owned > 0
    return ownedFilter === "owned" ? owned : !owned
  })
}

/** Distinct, sorted badge slugs present across the current listing set. */
export function collectBadgeOptions(listings: { badgeSlugs: string[] }[]): string[] {
  const seen = new Set<string>()
  for (const l of listings) for (const b of l.badgeSlugs) if (b) seen.add(b)
  return Array.from(seen).sort()
}

/** State the active-filter counter reads. Arrays are the multi-selects; the
 * strings are the text/number inputs (empty string = inactive). */
export interface ActiveFilterState {
  tiersSel: string[]
  setsSel: string[]
  seriesSel: string[]
  teamsSel: string[]
  badgesSel: string[]
  minPrice: string
  maxPrice: string
  minDiscount: string
  debouncedPlayer: string
  ownedFilter: OwnedFilter
}

/** How many filters are currently active — drives the "Filters (N)" badge. */
export function countActiveFilters(s: ActiveFilterState): number {
  let n = 0
  if (s.tiersSel.length > 0) n++
  if (s.setsSel.length > 0) n++
  if (s.seriesSel.length > 0) n++
  if (s.teamsSel.length > 0) n++
  if (s.badgesSel.length > 0) n++
  if (s.minPrice) n++
  if (s.maxPrice) n++
  if (s.minDiscount) n++
  if (s.debouncedPlayer) n++
  if (s.ownedFilter !== "all") n++
  return n
}
