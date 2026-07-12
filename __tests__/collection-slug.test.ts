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
  it("returns all 5 published collections as a fresh copy", () => {
    const list = listEntityPageCollections()
    expect(list).toHaveLength(5)
    // mutating the returned array must not affect subsequent calls
    list.pop()
    expect(listEntityPageCollections()).toHaveLength(5)
  })
})

describe("isPinnacleUrlSlug", () => {
  it("is true only for disney-pinnacle", () => {
    expect(isPinnacleUrlSlug("disney-pinnacle")).toBe(true)
    expect(isPinnacleUrlSlug("ufc")).toBe(false)
    expect(isPinnacleUrlSlug("nba-top-shot")).toBe(false)
  })
})
