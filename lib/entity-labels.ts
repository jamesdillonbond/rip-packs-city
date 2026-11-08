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
  /** "Players" | "Characters" — plural, for stat cells and section titles. */
  players: string
  /** "Team" | "Franchise" — singular form. */
  team: string
  /** "Roster" | "Cast" — collective noun for the team-page player grid. */
  roster: string
  /** "Headshot" | "Portrait" — alt text + image label. */
  portrait: string
  /** "Tier" | "Variant" — Pinnacle calls scarcity bands "variants". */
  tier: string
  /** "Moment" | "Pin" — the collectible itself, singular. */
  unit: string
  /** "Moments" | "Pins" — plural, for column headers and counts. */
  units: string
}

const PINNACLE: EntityLabels = {
  player: "Character",
  players: "Characters",
  team: "Franchise",
  roster: "Cast",
  portrait: "Portrait",
  tier: "Variant",
  unit: "Pin",
  units: "Pins",
}

const SPORTS: EntityLabels = {
  player: "Player",
  players: "Players",
  team: "Team",
  roster: "Roster",
  portrait: "Headshot",
  tier: "Tier",
  unit: "Moment",
  units: "Moments",
}

// ── Panini (2026-11-08) ──────────────────────────────────────────────────────
// Panini sells CARDS, not Moments, in every product — sports included. Its
// Entertainment filter adds non-sport lines whose Panini fields reuse sports
// names (`team` = the IP / brand / band, `athlete` = the figure on the card),
// so a product carries a label set (panini_products.label_set; NULL = by its grid
// sport): Bad Egg Co. / Moonbirds are Characters of a Franchise (Pinnacle's
// vocabulary); a band's members are Artists of a Band. The products bridge mints
// no players rows for either (they are not people on a roster).
export type PaniniLabelSet = "sports" | "entertainment" | "music"

const PANINI_SPORTS: EntityLabels = { ...SPORTS, unit: "Card", units: "Cards" }

const PANINI_ENTERTAINMENT: EntityLabels = {
  player: "Character",
  players: "Characters",
  team: "Franchise",
  roster: "Cast",
  portrait: "Portrait",
  tier: "Tier",
  unit: "Card",
  units: "Cards",
}

const PANINI_MUSIC: EntityLabels = {
  player: "Artist",
  players: "Artists",
  team: "Band",
  roster: "Lineup",
  portrait: "Portrait",
  tier: "Tier",
  unit: "Card",
  units: "Cards",
}

/**
 * Labels for a collection's pages. `labelSet` matters only for Panini, whose one
 * collection mixes sports and entertainment products: entity pages pass the set
 * their product resolves to (lib/panini/label-set.ts); collection-wide surfaces
 * omit it and get the sports nouns with Panini's unit.
 */
export function getEntityLabels(collectionUrlSlug: string, labelSet?: PaniniLabelSet | null): EntityLabels {
  if (isPinnacleUrlSlug(collectionUrlSlug)) return PINNACLE
  if (collectionUrlSlug === "panini-blockchain") {
    if (labelSet === "music") return PANINI_MUSIC
    if (labelSet === "entertainment") return PANINI_ENTERTAINMENT
    return PANINI_SPORTS
  }
  return SPORTS
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
