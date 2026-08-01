// lib/collection-tiers.ts
//
// SINGLE SOURCE OF TRUTH for "which scarcity tiers can this collection actually
// have" — used by the per-collection Sniper tier chips and the Market tier
// filter, which previously kept two independent hardcoded lists and disagreed
// with each other AND with the database.
//
// The values are the live `editions.tier` vocabulary, measured 2026-08-01:
//
//   nba_top_shot    COMMON 9,637 · RARE 5,588 · LEGENDARY 2,205 · FANDOM 830 · ULTIMATE 256
//   nfl_all_day     RARE 2,470 · COMMON 1,611 · LEGENDARY 1,056 · UNCOMMON 630 · ULTIMATE 423
//   laliga_golazos  UNCOMMON 215 · RARE 195 · COMMON 125 · LEGENDARY 40
//   ufc_strike      CONTENDER 460 · CHALLENGER 55 · FANDOM 2 · CHAMPION 1
//   disney_pinnacle (none — Pinnacle bands are VARIANTS, not tiers)
//
// Defects this fixed (2026-08-01 rendered-DOM QA sweep):
//   * UFC Strike's Sniper chips were the Top Shot list
//     (common/uncommon/fandom/rare/legendary/ultimate), so FIVE of six chips
//     could never match and 515 of 518 editions were unfilterable.
//   * The Market list omitted UNCOMMON for NFL All Day (630 editions
//     unreachable) and carried a dead FANDOM chip for LaLiga Golazos (0 rows).
//
// Keyed by the URL slug used in the `[collection]` route segment (lib/collections.ts
// `urlSlug`), with the "pinnacle" alias included because the Sniper route accepts it.
//
// ⚠ When a collection gains a tier on-chain, update the map here — not in a page.

/** Canonical UPPERCASE tier vocabulary per collection URL slug. */
export const COLLECTION_TIERS: Record<string, readonly string[]> = {
  "nba-top-shot": ["COMMON", "FANDOM", "RARE", "LEGENDARY", "ULTIMATE"],
  "nfl-all-day": ["COMMON", "UNCOMMON", "RARE", "LEGENDARY", "ULTIMATE"],
  "laliga-golazos": ["COMMON", "UNCOMMON", "RARE", "LEGENDARY"],
  "ufc": ["CONTENDER", "CHALLENGER", "FANDOM", "CHAMPION"],
  // Pinnacle scarcity is expressed as variant_type, not tier — both surfaces
  // render a variant picker instead, so an empty tier list is correct.
  "disney-pinnacle": [],
  "pinnacle": [],
}

// Union fallback for a slug we don't know yet. Deliberately the UNION rather
// than one collection's list: an unknown collection showing a superset is a
// cosmetic wart, whereas showing the WRONG collection's list silently makes
// rows unreachable (the UFC bug).
const ALL_TIERS: readonly string[] = [
  "COMMON", "UNCOMMON", "FANDOM", "RARE", "LEGENDARY", "ULTIMATE",
  "CONTENDER", "CHALLENGER", "CHAMPION",
]

/** Tiers for a collection URL slug (UPPERCASE). Unknown slug → the union. */
export function collectionTiers(urlSlug: string): readonly string[] {
  const hit = COLLECTION_TIERS[urlSlug]
  return hit ?? ALL_TIERS
}

/**
 * Sniper quick-tab list: an "all" chip followed by the collection's real tiers,
 * lowercased (the Sniper sends the chip value straight through as the `tier`
 * query param, which the feed matches case-insensitively).
 * Returns just ["all"] for a variant-based collection (Pinnacle), whose caller
 * substitutes its own variant tabs.
 */
export function sniperTierTabs(urlSlug: string): readonly string[] {
  return ["all", ...collectionTiers(urlSlug).map((t) => t.toLowerCase())]
}
