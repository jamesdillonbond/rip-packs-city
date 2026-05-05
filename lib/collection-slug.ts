// lib/collection-slug.ts
// Phase 1A foundation utility.
//
// Thin facade over the canonical registry in lib/collections.ts that exposes
// the exact { id, dbSlug, displayName, urlSlug } shape used by every entity
// detail page (edition / set / player / team / series) and their metadata
// helpers. Returns null for unknown inputs so route handlers can call
// notFound() cleanly.
//
// The five published collections are hardcoded here (no extra fields) so
// callers don't have to import the full Collection record when they only
// need slugs + display name.
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
