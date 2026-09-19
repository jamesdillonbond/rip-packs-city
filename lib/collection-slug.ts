// lib/collection-slug.ts
// Phase 1A foundation utility.
//
// Thin facade over the canonical registry in lib/collections.ts that exposes
// the exact { id, dbSlug, displayName, urlSlug } shape used by every entity
// detail page (edition / set / player / team / series) and their metadata
// helpers. Returns null for unknown inputs so route handlers can call
// notFound() cleanly.
//
// The entity-page collections are hardcoded here (no extra fields) so
// callers don't have to import the full Collection record when they only
// need slugs + display name.
//
// ── Candy MLB added 2026-09-19 (it was deliberately excluded until now) ─────
// The exclusion was recorded in __tests__/collection-registry-consistency.ts as
// "THIN — overview only, no entity corpus ... the entity pages are Flow-shaped".
// Both halves of that premise are now false, and the second one was costing
// readers real pages:
//
//   1. NOT THIN. Candy shipped a Market tab on 2026-09-12 with its own Solana
//      dispatch, and MarketClient links every row it renders to
//      /<collection>/edition/<editionKey>, plus /player, /team and /set.
//      MEASURED against the live page 2026-09-19: ONE render of
//      /candy-mlb/market emits 54 edition links, 10 team links, 10 player links
//      and a set link — and every one of them 404s, because this facade is the
//      gate. Confirmed by status code: /candy-mlb/market 200,
//      /candy-mlb/edition/mike-trout-pink 404, /candy-mlb/set/2026-mlb-base-
//      series-icons 404. A shipped public tab whose every row is a dead link.
//
//   2. NOT FLOW-SHAPED. The entity pages read collection-generic RPCs, and they
//      already answer for Candy TODAY, unchanged: get_edition_detail,
//      get_player_detail, get_set_detail and get_team_detail were each called
//      live against the Candy UUID before this edit and each returned a
//      populated row (e.g. `mike-trout-pink` → FMV $84.65 MEDIUM, 9 sales/30d,
//      set "2026 MLB Base Series ICONs", tier LEGENDARY, circulation 15,
//      Arweave art). Candy's 125 editions are 100% FMV-covered, 125/125 carry
//      player/set/tier/team/circulation, and `external_id` is already an
//      SEO-shaped slug ("mike-trout-pink") rather than a Flow integer pair.
//      The Flow-specific arms on those pages are collection-gated already —
//      insight links are `collection === "nba-top-shot"` only, the Top Shot CDN
//      hero candidate is `isTopShotColl` only, dapperMarketEditionUrl returns
//      null for a non-numeric external_id, and proxyIpfsUrl passes an
//      arweave.net URL through untouched.
//
// ⚠ Pinnacle stays the one special case (see isPinnacleUrlSlug).
//
// NOTE on UFC: Trevor's spec lists "ufc-strike" as the URL slug. The deployed
// app currently routes UFC under "/ufc/..." (lib/collections.ts id "ufc").
// To avoid breaking live URLs, the canonical urlSlug emitted by these helpers
// is "ufc". Both "ufc" and "ufc-strike" are accepted as INPUT to
// getCollectionByUrlSlug() so external links using either form resolve.

export interface CollectionSlugInfo {
  /** Supabase collections.id UUID. */
  id: string
  /** Underscore-form slug used by the Postgres RPCs and the `collections.slug` column. */
  dbSlug: string
  /** Human-readable display name. */
  displayName: string
  /** Canonical hyphenated URL segment used in app routes. */
  urlSlug: string
}

const RECORDS: CollectionSlugInfo[] = [
  {
    id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
    dbSlug: "nba_top_shot",
    displayName: "NBA Top Shot",
    urlSlug: "nba-top-shot",
  },
  {
    id: "dee28451-5d62-409e-a1ad-a83f763ac070",
    dbSlug: "nfl_all_day",
    displayName: "NFL All Day",
    urlSlug: "nfl-all-day",
  },
  {
    id: "06248cc4-b85f-47cd-af67-1855d14acd75",
    dbSlug: "laliga_golazos",
    displayName: "LaLiga Golazos",
    urlSlug: "laliga-golazos",
  },
  {
    id: "9b4824a8-736d-4a96-b450-8dcc0c46b023",
    dbSlug: "ufc_strike",
    displayName: "UFC Strike",
    urlSlug: "ufc",
  },
  {
    id: "7dd9dd11-e8b6-45c4-ac99-71331f959714",
    dbSlug: "disney_pinnacle",
    displayName: "Disney Pinnacle",
    urlSlug: "disney-pinnacle",
  },
  {
    id: "209ade70-32c5-4470-bc7c-4793d660f713",
    dbSlug: "candy_mlb",
    displayName: "Candy MLB",
    urlSlug: "candy-mlb",
  },
]

const BY_URL_SLUG = new Map<string, CollectionSlugInfo>()
for (const r of RECORDS) BY_URL_SLUG.set(r.urlSlug, r)
// Aliases — accept both ufc and ufc-strike on input.
BY_URL_SLUG.set("ufc-strike", RECORDS.find(r => r.dbSlug === "ufc_strike")!)

const BY_UUID = new Map<string, CollectionSlugInfo>(RECORDS.map(r => [r.id, r]))
const BY_DB_SLUG = new Map<string, CollectionSlugInfo>(RECORDS.map(r => [r.dbSlug, r]))

export function getCollectionByUrlSlug(urlSlug: string): CollectionSlugInfo | null {
  return BY_URL_SLUG.get(urlSlug) ?? null
}

export function getCollectionByUuid(uuid: string): CollectionSlugInfo | null {
  return BY_UUID.get(uuid) ?? null
}

export function getCollectionByDbSlug(dbSlug: string): CollectionSlugInfo | null {
  return BY_DB_SLUG.get(dbSlug) ?? null
}

export function listEntityPageCollections(): CollectionSlugInfo[] {
  return RECORDS.slice()
}

/** True when the URL slug refers to Disney Pinnacle (the special-case collection). */
export function isPinnacleUrlSlug(urlSlug: string): boolean {
  return urlSlug === "disney-pinnacle"
}
