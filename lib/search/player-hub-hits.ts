// lib/search/player-hub-hits.ts
//
// Search results -> player hub links (2026-10-22).
//
// rpc_search_catalog returns ONE player row PER COLLECTION, so "damian lillard"
// listed "Damian Lillard · Panini" and "Damian Lillard · NBA Top Shot" as two
// rows, and Enter opened whichever scored higher (Panini, by 0.012). Now:
//
//   · every player row (Disney Pinnacle characters aside) links to the
//     collection-agnostic hub, /players/<slug>. The hub redirects to the
//     collection page when only one collection carries the name, and it folds
//     registered aliases, so the Top Shot "Steph Curry" row and the Panini
//     "Stephen Curry" row reach the same page;
//   · rows with the SAME slug collapse into one, at the position of the first
//     (highest-scored) one, naming every collection and summing the editions.
//
// Order is otherwise untouched: the RPC's ranking stays the ranking.

import { playerHubPath } from "@/lib/player-hub-path"

export interface SearchResult {
  kind: string
  label: string
  sublabel: string | null
  href: string
  collection: string
  collectionName: string
  thumbnailUrl: string | null
  editionCount: number | null
  /** url slugs of every collection the row stands for (2+ on a merged player row) */
  collections?: string[]
}

/** The input row: a mapped result plus the RPC's entity slug. */
export interface SearchResultWithSlug extends SearchResult {
  slug: string
}

const NOT_HUBBED = new Set(["disney-pinnacle"])

export function mergePlayerHubHits(rows: SearchResultWithSlug[]): SearchResult[] {
  const out: SearchResult[] = []
  const bySlug = new Map<string, SearchResult>()
  for (const { slug, ...r } of rows) {
    if (r.kind !== "player" || NOT_HUBBED.has(r.collection) || !slug) {
      out.push(r)
      continue
    }
    const seen = bySlug.get(slug)
    if (!seen) {
      const hit: SearchResult = { ...r, href: playerHubPath(slug), collections: [r.collection] }
      bySlug.set(slug, hit)
      out.push(hit)
      continue
    }
    if (seen.collections?.includes(r.collection)) continue
    seen.collections = [...(seen.collections ?? []), r.collection]
    seen.collectionName = `${seen.collectionName} + ${r.collectionName}`
    seen.editionCount =
      seen.editionCount == null && r.editionCount == null ? null : (seen.editionCount ?? 0) + (r.editionCount ?? 0)
    seen.thumbnailUrl = seen.thumbnailUrl ?? r.thumbnailUrl
  }
  return out
}
