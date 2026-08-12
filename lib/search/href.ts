// lib/search/href.ts
//
// Turns a rpc_search_catalog row into the route it should link to. Lives in
// lib/ (not inline in app/api/search/route.ts) so the primary coverage gate
// measures it — a wrong href here is invisible to typecheck and produces a
// search result that 404s on click, which is worse than no search at all.
//
// The slug shapes are produced by the RPC to match what each page resolves:
//   player / set / team — the canonical slugification (trim → lower → runs of
//     non-alphanumerics to a single hyphen), the same expression the entity
//     RPCs use and that lib/entity-labels.slugifyName mirrors.
//   edition — coalesce(external_id, id::text), which is what the edition page
//     and the sitemap both call route_slug.
//
// Anything whose kind is not one of the four known ones returns null rather
// than guessing a path, so an added RPC arm cannot silently ship dead links.

/** Row shape returned by the rpc_search_catalog RPC. */
export interface SearchHit {
  kind: string
  label: string
  sublabel: string | null
  slug: string
  collection_id: string
  collection_slug: string
  thumbnail_url: string | null
  edition_count: number | null
  score: number
}

const SEGMENT_BY_KIND: Record<string, string> = {
  player: "player",
  set: "set",
  team: "team",
  edition: "edition",
}

/**
 * Build the app route for a search hit.
 *
 * @param kind             result kind from the RPC
 * @param collectionUrlSlug the hyphenated route segment ("nba-top-shot")
 * @param slug             the entity's route slug
 * @returns the path, or null when the kind is unknown or either input is empty
 */
export function buildSearchHref(
  kind: string,
  collectionUrlSlug: string,
  slug: string
): string | null {
  const segment = Object.prototype.hasOwnProperty.call(SEGMENT_BY_KIND, kind)
    ? SEGMENT_BY_KIND[kind]
    : undefined
  if (!segment) return null
  if (!collectionUrlSlug || !slug) return null

  // Edition slugs contain ':' (and '::' for parallels), which is legal in a
  // path segment but must survive a round trip through the router, so encode.
  return `/${collectionUrlSlug}/${segment}/${encodeURIComponent(slug)}`
}

/** Human label for a result kind, for the type chip in the results list. */
export function searchKindLabel(kind: string, isPinnacle: boolean): string {
  if (kind === "player") return isPinnacle ? "CHARACTER" : "PLAYER"
  if (kind === "team") return isPinnacle ? "FRANCHISE" : "TEAM"
  if (kind === "set") return "SET"
  if (kind === "edition") return "MOMENT"
  return kind.toUpperCase()
}
