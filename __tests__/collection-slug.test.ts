import { describe, it, expect } from "vitest"
import {
  getCollectionByUrlSlug,
  getCollectionByUuid,
  getCollectionByDbSlug,
  listEntityPageCollections,
  isPinnacleUrlSlug,
} from "@/lib/collection-slug"

// The slug facade behind every entity detail page. UFC accepts both "ufc" and
// "ufc-strike" as input but emits canonical urlSlug "ufc". Pin the lookups +
// the alias + null-on-unknown so route handlers notFound() cleanly.

describe("getCollectionByUrlSlug", () => {
  it("resolves each canonical url slug", () => {
    expect(getCollectionByUrlSlug("nba-top-shot")?.dbSlug).toBe("nba_top_shot")
    expect(getCollectionByUrlSlug("disney-pinnacle")?.dbSlug).toBe("disney_pinnacle")
  })

  it("accepts both 'ufc' and 'ufc-strike', resolving to the same record", () => {
    const a = getCollectionByUrlSlug("ufc")
    const b = getCollectionByUrlSlug("ufc-strike")
    expect(a?.dbSlug).toBe("ufc_strike")
    expect(b?.dbSlug).toBe("ufc_strike")
    expect(a?.urlSlug).toBe("ufc") // canonical url slug is "ufc"
  })

  it("returns null for unknown slugs", () => {
    expect(getCollectionByUrlSlug("nope")).toBeNull()
  })
})

describe("getCollectionByUuid / getCollectionByDbSlug", () => {
  it("resolves by uuid and db slug", () => {
    expect(getCollectionByUuid("9b4824a8-736d-4a96-b450-8dcc0c46b023")?.urlSlug).toBe("ufc")
    expect(getCollectionByDbSlug("nfl_all_day")?.urlSlug).toBe("nfl-all-day")
    expect(getCollectionByUuid("00000000-0000-0000-0000-000000000000")).toBeNull()
  })
})

describe("listEntityPageCollections", () => {
  it("returns all 6 entity-page collections as a fresh copy", () => {
    const list = listEntityPageCollections()
    expect(list).toHaveLength(6)
    // mutating the returned array must not affect subsequent calls
    list.pop()
    expect(listEntityPageCollections()).toHaveLength(6)
  })
})

// Candy MLB (2026-09-19). Registered because /candy-mlb/market — shipped and
// public since 2026-09-12 — links every row it renders to /candy-mlb/edition/
// <editionKey>, /player, /team and /set, and this facade is the gate those
// routes pass through. Measured on the LIVE page the day this was added: one
// render emitted 54 edition links, all 404. Pinned here so a future "thin
// collection" tidy-up cannot silently re-break them.
describe("candy-mlb resolves through the facade", () => {
  it("resolves by url slug, uuid and db slug to the same record", () => {
    const byUrl = getCollectionByUrlSlug("candy-mlb")
    expect(byUrl).not.toBeNull()
    expect(byUrl!.dbSlug).toBe("candy_mlb")
    expect(byUrl!.id).toBe("209ade70-32c5-4470-bc7c-4793d660f713")
    expect(byUrl!.displayName).toBe("Candy MLB")
    expect(getCollectionByUuid(byUrl!.id)).toEqual(byUrl)
    expect(getCollectionByDbSlug("candy_mlb")).toEqual(byUrl)
  })

  it("is not treated as the Pinnacle special case", () => {
    // isPinnacleUrlSlug gates a 308 to /pinnacle/moment/<render_id>. A false
    // positive here would redirect every Candy edition URL into a key space
    // that has no Candy rows.
    expect(isPinnacleUrlSlug("candy-mlb")).toBe(false)
  })
})

describe("isPinnacleUrlSlug", () => {
  it("is true only for disney-pinnacle", () => {
    expect(isPinnacleUrlSlug("disney-pinnacle")).toBe(true)
    expect(isPinnacleUrlSlug("ufc")).toBe(false)
    expect(isPinnacleUrlSlug("nba-top-shot")).toBe(false)
  })
})
