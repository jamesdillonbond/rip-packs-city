import { describe, it, expect } from "vitest"
import {
  COLLECTION_UUID_BY_SLUG,
  SLUG_TO_DB_SLUG,
  publishedCollections,
  COLLECTIONS,
} from "@/lib/collections"
import {
  getCollectionByUrlSlug,
  getCollectionByUuid,
  getCollectionByDbSlug,
  listEntityPageCollections,
} from "@/lib/collection-slug"

// Cross-module drift guard. lib/collection-slug.ts is a SEPARATE facade with its
// own hardcoded RECORDS table (id / dbSlug / urlSlug) used by every entity detail
// page (edition / set / player / team / series). Nothing forces it to agree with
// the canonical registry in lib/collections.ts, so an edit to one — a re-slugged
// collection, a corrected UUID, a new publish — can silently desync the two and
// break entity-page routing while the collections.ts unit tests stay green.
// These assertions fail the moment the two sources disagree.

const PUBLISHED_URL_SLUGS = ["nba-top-shot", "nfl-all-day", "laliga-golazos", "ufc", "disney-pinnacle"]

describe("collection-slug facade agrees with the collections.ts registry", () => {
  it("covers exactly the 5 published collections and no more", () => {
    const facadeSlugs = listEntityPageCollections()
      .map((r) => r.urlSlug)
      .sort()
    expect(facadeSlugs).toEqual([...PUBLISHED_URL_SLUGS].sort())
    // And those are precisely the published set in the canonical registry.
    expect(publishedCollections().map((c) => c.id).sort()).toEqual([...PUBLISHED_URL_SLUGS].sort())
  })

  it.each(PUBLISHED_URL_SLUGS)("%s: UUID + dbSlug match across both modules", (urlSlug) => {
    const facade = getCollectionByUrlSlug(urlSlug)
    expect(facade).not.toBeNull()

    // UUID must match COLLECTION_UUID_BY_SLUG in collections.ts.
    expect(facade!.id).toBe(COLLECTION_UUID_BY_SLUG[urlSlug])
    // dbSlug (underscore form) must match SLUG_TO_DB_SLUG in collections.ts.
    expect(facade!.dbSlug).toBe(SLUG_TO_DB_SLUG[urlSlug])
  })

  // displayName was the ONE field of the facade's { id, dbSlug, displayName,
  // urlSlug } record that nothing cross-checked, so a rename in collections.ts
  // (or a typo here) could desync the label every entity page renders while the
  // rest of this suite stayed green. Closed 2026-08-01.
  it.each(PUBLISHED_URL_SLUGS)("%s: displayName matches the registry label", (urlSlug) => {
    const facade = getCollectionByUrlSlug(urlSlug)!
    const canonical = COLLECTIONS.find((c) => c.id === urlSlug)
    expect(canonical).toBeDefined()
    expect(facade.displayName).toBe(canonical!.label)
  })

  it("facade UUID and dbSlug lookups round-trip to the same record", () => {
    for (const urlSlug of PUBLISHED_URL_SLUGS) {
      const byUrl = getCollectionByUrlSlug(urlSlug)!
      expect(getCollectionByUuid(byUrl.id)).toEqual(byUrl)
      expect(getCollectionByDbSlug(byUrl.dbSlug)).toEqual(byUrl)
    }
  })

  it("accepts the 'ufc-strike' alias but still emits the canonical 'ufc' urlSlug", () => {
    const alias = getCollectionByUrlSlug("ufc-strike")
    expect(alias).not.toBeNull()
    expect(alias!.urlSlug).toBe("ufc")
    expect(alias!.dbSlug).toBe("ufc_strike")
    // Alias and canonical resolve to the identical record.
    expect(alias).toEqual(getCollectionByUrlSlug("ufc"))
  })

  it("does not expose unpublished chain-two placeholders through the entity facade", () => {
    expect(getCollectionByUrlSlug("candy-mlb")).toBeNull()
    expect(getCollectionByUrlSlug("panini-blockchain")).toBeNull()
  })
})
