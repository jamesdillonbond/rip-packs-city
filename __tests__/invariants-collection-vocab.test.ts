import { describe, it, expect } from "vitest"
import {
  SLUG_TO_DB_SLUG,
  DB_SLUG_TO_SLUG,
  COLLECTION_UUID_BY_SLUG,
  toDbSlug,
  fromDbSlug,
  getCollectionUuid,
} from "@/lib/collections"

// ARCHITECTURE GUARD — the two collection-string vocabularies.
//
// Per CLAUDE.md ("CRITICAL footgun"): the DB uses TWO distinct vocabularies —
// hyphen frontend slugs ("nba-top-shot", "ufc") vs underscore DB slugs
// ("nba_top_shot", "ufc_strike"). They are NOT interchangeable; mixing them
// fails INSERTs against CHECK constraints (e.g. writing "ufc_strike" to a
// flowty_* table, or "ufc" where the long form is required). This pins the
// canonical bridge in lib/collections.ts so the maps + helpers can't drift.

const PUBLISHED = ["nba-top-shot", "nfl-all-day", "laliga-golazos", "ufc", "disney-pinnacle"]

describe("invariant: collection slug <-> db-slug bridge", () => {
  it("pins the documented hyphen->underscore mapping for published collections", () => {
    expect(SLUG_TO_DB_SLUG["nba-top-shot"]).toBe("nba_top_shot")
    expect(SLUG_TO_DB_SLUG["nfl-all-day"]).toBe("nfl_all_day")
    expect(SLUG_TO_DB_SLUG["laliga-golazos"]).toBe("laliga_golazos")
    // the classic footgun: hyphen "ufc" maps to underscore "ufc_strike"
    expect(SLUG_TO_DB_SLUG["ufc"]).toBe("ufc_strike")
    expect(SLUG_TO_DB_SLUG["disney-pinnacle"]).toBe("disney_pinnacle")
  })

  it("hyphen slugs and db slugs are genuinely distinct vocabularies", () => {
    for (const [slug, db] of Object.entries(SLUG_TO_DB_SLUG)) {
      // frontend slugs are hyphenated, DB slugs are underscored — never mixed
      expect(slug.includes("_"), `frontend slug ${slug} must not contain '_'`).toBe(false)
      expect(db.includes("-"), `db slug ${db} must not contain '-'`).toBe(false)
    }
  })

  it("toDbSlug / fromDbSlug round-trip for every mapping and null on unknown", () => {
    for (const [slug, db] of Object.entries(SLUG_TO_DB_SLUG)) {
      expect(toDbSlug(slug)).toBe(db)
      expect(fromDbSlug(db)).toBe(slug)
    }
    expect(toDbSlug("not-a-collection")).toBeNull()
    expect(fromDbSlug("not_a_collection")).toBeNull()
  })

  it("DB_SLUG_TO_SLUG is the exact inverse of SLUG_TO_DB_SLUG (no lossy collisions)", () => {
    expect(Object.keys(DB_SLUG_TO_SLUG).length).toBe(Object.keys(SLUG_TO_DB_SLUG).length)
    for (const [slug, db] of Object.entries(SLUG_TO_DB_SLUG)) {
      expect(DB_SLUG_TO_SLUG[db]).toBe(slug)
    }
  })

  it("every published collection resolves to its canonical UUID", () => {
    // Pin the UUIDs documented in CLAUDE.md so a mis-seeded id is caught.
    expect(getCollectionUuid("nba-top-shot")).toBe("95f28a17-224a-4025-96ad-adf8a4c63bfd")
    expect(getCollectionUuid("nfl-all-day")).toBe("dee28451-5d62-409e-a1ad-a83f763ac070")
    expect(getCollectionUuid("laliga-golazos")).toBe("06248cc4-b85f-47cd-af67-1855d14acd75")
    expect(getCollectionUuid("ufc")).toBe("9b4824a8-736d-4a96-b450-8dcc0c46b023")
    expect(getCollectionUuid("disney-pinnacle")).toBe("7dd9dd11-e8b6-45c4-ac99-71331f959714")
    expect(getCollectionUuid("not-a-collection")).toBeNull()
  })

  it("every published collection has a slug, db-slug and UUID entry (no partial wiring)", () => {
    for (const slug of PUBLISHED) {
      expect(SLUG_TO_DB_SLUG[slug], slug).toBeTruthy()
      expect(COLLECTION_UUID_BY_SLUG[slug], slug).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )
    }
  })

  it("all UUIDs are unique across collections", () => {
    const ids = Object.values(COLLECTION_UUID_BY_SLUG)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
