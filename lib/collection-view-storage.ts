// lib/collection-view-storage.ts
//
// localStorage keys for the Collection tab's saved view.
//
// ⛔ A FILTER IS A CLAIM ABOUT ONE COLLECTION'S ROWS. Until 2026-11-10 every key was the bare
// `rpc_collection_<field>`, shared by all seven collections, so a player filter picked on Top
// Shot ("Luka Dončić") was restored on the Golazos tab and a wallet holding 45 Golazos moments
// read "No moments match your current filters" — with a filter the collector never set there
// (seen on the signed-in tab). A player, set, series, rarity, lock state or badge filter names
// values that exist in one collection, so those keys carry the collection slug.
//
// The SORT is a preference about the table, not about its rows, and stays shared.
//
// The old shared filter keys are not read: their values are exactly the defect. They are
// removed on first load so they stop occupying storage.

export const SHARED_VIEW_FIELDS = ["sortKey", "sortDirection"] as const
export const SCOPED_VIEW_FIELDS = [
  "playerFilter",
  "setFilter",
  "seriesFilter",
  "rarityFilter",
  "lockedFilter",
  "badgeFilter",
] as const

export type SharedViewField = (typeof SHARED_VIEW_FIELDS)[number]
export type ScopedViewField = (typeof SCOPED_VIEW_FIELDS)[number]
export type ViewField = SharedViewField | ScopedViewField

const PREFIX = "rpc_collection_"

function isShared(field: ViewField): field is SharedViewField {
  return (SHARED_VIEW_FIELDS as readonly string[]).includes(field)
}

/** The storage key for one saved view field on one collection's tab. */
export function collectionViewStorageKey(collectionSlug: string, field: ViewField): string {
  return isShared(field) ? PREFIX + field : PREFIX + field + ":" + collectionSlug
}

/** The pre-11-10 shared key for a filter field. Never read; only removed. */
export function legacySharedFilterKey(field: ScopedViewField): string {
  return PREFIX + field
}
