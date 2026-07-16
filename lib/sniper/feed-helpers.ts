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
