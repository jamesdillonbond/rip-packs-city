// lib/insights/trophy-collections.ts
//
// The Trophy Room's collections and tabs, derived from the registry (every
// PUBLISHED collection). Pure (no DB client), so the client board and the server
// fetcher share one list. 2026-10-18 (Trevor: "All supported collections should
// be usable there"): this was a hand list that missed collections as they were
// added. Disney Pinnacle's pins live in pinnacle_catalog, not `editions`, so the
// fetcher reads it separately (PINNACLE_TROPHY_COLLECTION).

import { publishedCollections, toDbSlug } from "@/lib/collections"

export const PINNACLE_TROPHY_COLLECTION = "disney_pinnacle"

export const TROPHY_COLLECTION_TABS: ReadonlyArray<{ val: string; label: string }> = publishedCollections()
  .map((c) => ({ val: toDbSlug(c.id), label: c.label }))
  .filter((t): t is { val: string; label: string } => !!t.val)

export const TROPHY_COLLECTIONS: readonly string[] = TROPHY_COLLECTION_TABS.map((t) => t.val)
