// lib/sniper/feed-helpers.ts
//
// Pure, side-effect-free helpers extracted from app/api/sniper-feed/route.ts so
// they can be unit-tested independently of the route's live TopShot/AllDay
// GraphQL fan-out (which cannot be driven in a unit suite). The route imports
// these back; behavior is unchanged. Keep this file free of network/DB I/O.

/** Minimal structural shape parseListingPrice reads — a RawListing satisfies it. */
export interface ListingPriceFields {
  marketplacePrice?: number
  flowRetailPrice?: { value: string }
  lowAsk?: number
}

/**
 * Extract the USD ask price from a listing, trying multiple upstream field
 * shapes in priority order: explicit marketplacePrice, then the string-encoded
 * flowRetailPrice, then the edition-level lowAsk. Returns 0 when none is a
 * positive number (the route treats 0 as "no usable ask").
 */
export function parseListingPrice(l: ListingPriceFields): number {
  if (typeof l.marketplacePrice === "number" && l.marketplacePrice > 0) return l.marketplacePrice
  if (l.flowRetailPrice?.value) {
    const parsed = parseFloat(l.flowRetailPrice.value)
    if (!isNaN(parsed) && parsed > 0) return parsed
  }
  if (typeof l.lowAsk === "number" && l.lowAsk > 0) return l.lowAsk
  return 0
}

/**
 * Canonical badge slug → short display label. Carries BOTH the snake_case slug
 * form (as it arrives on-chain / from the resolver) and the Title Case form (as
 * it arrives from some GQL surfaces) so a badge matches whichever shape the
 * upstream emits.
 */
export const BADGE_LABELS: Record<string, string> = {
  rookie_year: "Rookie Year", rookie_mint: "Rookie Mint", rookie_premiere: "Rookie Premiere",
  top_shot_debut: "TS Debut", three_star_rookie: "3★ Rookie", mvp: "MVP",
  championship_year: "Champ Year", rookie_of_the_year: "ROTY", fresh: "Fresh", autograph: "Auto",
  "Rookie Year": "Rookie Year", "Rookie Mint": "Rookie Mint", "Rookie Premiere": "Rookie Premiere",
  "Top Shot Debut": "TS Debut", "Three-Star Rookie": "3★ Rookie", "MVP Year": "MVP",
  "Championship Year": "Champ Year", "Rookie of the Year": "ROTY", "Fresh": "Fresh",
}

/** Set of every recognized badge key (both slug and title forms). */
export const KNOWN_BADGES = new Set(Object.keys(BADGE_LABELS))

/**
 * Reduce a raw tags array to the subset of recognized badge keys. A tag matches
 * on either its id (slug form) or its title, preferring id. Unknown tags are
 * dropped. Returns [] for undefined/empty input.
 */
export function extractBadgeSlugs(
  tags: Array<{ id?: string; title?: string }> | undefined,
): string[] {
  if (!tags) return []
  return tags
    .map((t) => {
      if (t.id && KNOWN_BADGES.has(t.id)) return t.id
      if (t.title && KNOWN_BADGES.has(t.title)) return t.title
      return null
    })
    .filter((s): s is string => s !== null)
}

/** Minimal fields the feed sort comparator reads off a deal. */
export interface SortableDeal {
  askPrice: number
  adjustedFmv: number
  serial: number
  updatedAt?: string | null
  discount: number
}

/**
 * Sort deals in place by the requested key, mirroring the feed's contract:
 *   price_asc | price_desc | fmv_desc | serial_asc | listed_desc,
 * with any other value (including the default "discount") sorting by descending
 * discount. Sorts in place and returns the same array (unchanged from the
 * route's original behavior).
 */
export function sortSniperDeals<T extends SortableDeal>(deals: T[], sortBy: string): T[] {
  return deals.sort((a, b) => {
    if (sortBy === "price_asc") return a.askPrice - b.askPrice
    if (sortBy === "price_desc") return b.askPrice - a.askPrice
    if (sortBy === "fmv_desc") return b.adjustedFmv - a.adjustedFmv
    if (sortBy === "serial_asc") return a.serial - b.serial
    if (sortBy === "listed_desc")
      return new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime()
    return b.discount - a.discount
  })
}

/** Minimal fields the edition-key dedup reads off a deal. */
export interface DedupableDeal {
  editionKey?: string | null
  intEditionKey?: string | null
  flowId: string
}

/**
 * Merge RPC-augment rows ahead of GQL rows and de-duplicate by edition key
 * (editionKey → intEditionKey → flowId). First occurrence of a key wins, so RPC
 * entries (passed first) beat GQL on collision because they carry the FMV the
 * sparse GQL pool may lack. Rows with no usable key are dropped.
 */
export function mergeDedupeByEditionKey<T extends DedupableDeal>(rpcDeals: T[], gqlDeals: T[]): T[] {
  const seenKeys = new Set<string>()
  const merged: T[] = []
  for (const d of [...rpcDeals, ...gqlDeals]) {
    const key = d.editionKey || d.intEditionKey || d.flowId
    if (!key || seenKeys.has(key)) continue
    seenKeys.add(key)
    merged.push(d)
  }
  return merged
}
