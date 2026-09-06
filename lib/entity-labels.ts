// lib/entity-labels.ts
// Phase 1A foundation utility.
//
// Pinnacle uses different domain vocabulary than the sports collections.
// Instead of hardcoding label flips inside every page, components ask
// getEntityLabels(urlSlug) for a complete label set and use those strings
// throughout. The page composition is identical across collections — only
// these strings differ.
//
// Also exports slugifyName() for player/team/character/franchise URL
// generation. Must match the Postgres expression used inside the entity
// detail RPCs exactly so URLs roundtrip:
//   regexp_replace(lower(trim(name)), '[^a-z0-9]+', '-', 'g')

import { isPinnacleUrlSlug } from "./collection-slug"

export interface EntityLabels {
  /** "Player" | "Character" — singular form for hero block + breadcrumbs. */
  player: string
  /** "Team" | "Franchise" — singular form. */
  team: string
  /** "Roster" | "Cast" — collective noun for the team-page player grid. */
  roster: string
  /** "Headshot" | "Portrait" — alt text + image label. */
  portrait: string
  /** "Tier" | "Variant" — Pinnacle calls scarcity bands "variants". */
  tier: string
}

const PINNACLE: EntityLabels = {
  player: "Character",
  team: "Franchise",
  roster: "Cast",
  portrait: "Portrait",
  tier: "Variant",
}

const SPORTS: EntityLabels = {
  player: "Player",
  team: "Team",
  roster: "Roster",
  portrait: "Headshot",
  tier: "Tier",
}

export function getEntityLabels(collectionUrlSlug: string): EntityLabels {
  return isPinnacleUrlSlug(collectionUrlSlug) ? PINNACLE : SPORTS
}

/**
 * Canonical slugification matching the Postgres expression used in entity RPCs.
 * Order: trim whitespace, lowercase, replace any run of non-alphanumerics with
 * a single hyphen. Leading/trailing hyphens are intentionally NOT stripped to
 * preserve roundtrip equivalence with the SQL expression.
 */
export function slugifyName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")
}

/**
 * Player-URL slug: `slugifyName` after stripping combining marks (NFD), so
 * "Vít Krejčí" becomes `vit-krejci` rather than `v-t-krej-`.
 *
 * ⚠ PLAYER URLs ONLY. Measured 2026-09-06: 4 of the sitemap's 1,413 Top Shot
 * player URLs 404'd because `editions.player_name` carries diacritics the
 * `players` row lacks (or vice versa), and the accented slug matches neither
 * side. The three player RPCs (`get_player_detail` / `_editions` / `_top_sales`,
 * migration `audit_20260906_player_slugs_resolve_unaccented…`) now ALSO match
 * `extensions.unaccent(p.name)`, so this slug resolves for every spelling.
 * Set and team resolvers do NOT unaccent — keep using `slugifyName` for those,
 * or an accented set/team name that resolves today stops resolving.
 */
export function slugifyPlayerName(name: string): string {
  return slugifyName(name.normalize("NFD").replace(/\p{M}/gu, ""))
}
