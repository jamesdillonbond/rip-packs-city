import { describe, it, expect } from "vitest"
import {
  toDbSlug,
  fromDbSlug,
  getCollectionUuid,
  getCollection,
  getCollectionByUuid,
  publishedCollections,
  SLUG_TO_DB_SLUG,
  COLLECTION_UUID_BY_SLUG,
} from "@/lib/collections"

// Guards the two-vocabulary slug bridge (URL-slug ↔ DB-slug ↔ UUID) that
// CLAUDE.md flags as a CRITICAL footgun: writing the wrong vocabulary to a
// table fails against CHECK constraints (e.g. `ufc` vs `ufc_strike`). These
// assertions pin the exact mapping for every collection and the round-trip
// invariant so a registry edit can't silently corrupt inserts.

// (urlSlug, dbSlug, uuid) — the canonical triple, kept in one place so a
// mismatch anywhere in the registry surfaces as a failing row.
const TRIPLES: Array<[string, string, string]> = [
  ["nba-top-shot", "nba_top_shot", "95f28a17-224a-4025-96ad-adf8a4c63bfd"],
  ["nfl-all-day", "nfl_all_day", "dee28451-5d62-409e-a1ad-a83f763ac070"],
  ["laliga-golazos", "laliga_golazos", "06248cc4-b85f-47cd-af67-1855d14acd75"],
  ["ufc", "ufc_strike", "9b4824a8-736d-4a96-b450-8dcc0c46b023"],
  ["disney-pinnacle", "disney_pinnacle", "7dd9dd11-e8b6-45c4-ac99-71331f959714"],
]

describe("slug ↔ dbSlug translation", () => {
  it.each(TRIPLES)("%s → dbSlug %s", (urlSlug, dbSlug) => {
    expect(toDbSlug(urlSlug)).toBe(dbSlug)
    expect(fromDbSlug(dbSlug)).toBe(urlSlug)
  })

  it("the UFC footgun: url slug 'ufc' maps to db 'ufc_strike', not 'ufc'", () => {
    expect(toDbSlug("ufc")).toBe("ufc_strike")
    expect(toDbSlug("ufc")).not.toBe("ufc")
  })

  it("round-trips every mapped slug", () => {
    for (const urlSlug of Object.keys(SLUG_TO_DB_SLUG)) {
      const db = toDbSlug(urlSlug)
      expect(db).not.toBeNull()
      expect(fromDbSlug(db!)).toBe(urlSlug)
    }
  })

  it("returns null for unknown slugs instead of guessing", () => {
    expect(toDbSlug("not-a-collection")).toBeNull()
    expect(fromDbSlug("not_a_collection")).toBeNull()
    expect(getCollectionUuid("not-a-collection")).toBeNull()
  })
})

describe("slug → UUID", () => {
  it.each(TRIPLES)("%s → uuid %s", (urlSlug, _dbSlug, uuid) => {
    expect(getCollectionUuid(urlSlug)).toBe(uuid)
  })

  it("UUID lookup tables stay in sync with each other", () => {
    for (const [urlSlug, uuid] of Object.entries(COLLECTION_UUID_BY_SLUG)) {
      expect(getCollectionUuid(urlSlug)).toBe(uuid)
    }
  })
})

describe("registry lookups", () => {
  it("getCollection resolves by id and getCollectionByUuid resolves by uuid", () => {
    for (const [urlSlug, _dbSlug, uuid] of TRIPLES) {
      const byId = getCollection(urlSlug)
      expect(byId).toBeDefined()
      const byUuid = getCollectionByUuid(uuid)
      expect(byUuid).toBeDefined()
      expect(byUuid!.id).toBe(byId!.id)
    }
  })

  it("publishedCollections returns exactly the 6 live collections (Candy MLB joined 2026-09-06)", () => {
    const ids = publishedCollections()
      .map((c) => c.id)
      .sort()
    expect(ids).toEqual(
      ["nba-top-shot", "nfl-all-day", "laliga-golazos", "ufc", "disney-pinnacle", "candy-mlb"].sort()
    )
  })

  it("unpublished placeholders (Panini, RWA) are not returned as published", () => {
    const ids = publishedCollections().map((c) => c.id)
    expect(ids).not.toContain("panini-blockchain")
    expect(ids).not.toContain("rwa")
  })
})
