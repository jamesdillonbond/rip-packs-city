import { describe, it, expect } from "vitest"
import {
  VALID_COLLECTIONS,
  VALID_TAGS,
  VALID_TAGS_BY_COLLECTION,
  VALID_TIERS,
  VALID_TIERS_ALLDAY,
  validTiersFor,
} from "@/lib/special-serial-owners-board"

// The Special Serial Owners board. The fetch fn hits a SECDEF RPC (DB), so only
// the pure whitelist constants + the collection→tier-set selector are tested:
// AllDay carries no jersey serial and uses a distinct tier vocabulary (UNCOMMON
// in place of Top Shot's FANDOM).

describe("collection + tag whitelists", () => {
  it("covers exactly Top Shot and AllDay", () => {
    expect(VALID_COLLECTIONS).toEqual(["nba-top-shot", "nfl-all-day"])
  })

  it("Top Shot has all three tags; AllDay drops jersey", () => {
    expect(VALID_TAGS).toEqual(["#1", "perfect", "jersey"])
    expect(VALID_TAGS_BY_COLLECTION["nba-top-shot"]).toEqual(["#1", "perfect", "jersey"])
    expect(VALID_TAGS_BY_COLLECTION["nfl-all-day"]).toEqual(["#1", "perfect"])
    expect(VALID_TAGS_BY_COLLECTION["nfl-all-day"]).not.toContain("jersey")
  })
})

describe("validTiersFor", () => {
  it("returns the AllDay tier set for nfl-all-day", () => {
    expect(validTiersFor("nfl-all-day")).toBe(VALID_TIERS_ALLDAY)
    expect(validTiersFor("nfl-all-day").has("UNCOMMON")).toBe(true)
    expect(validTiersFor("nfl-all-day").has("FANDOM")).toBe(false)
  })

  it("defaults to the Top Shot tier set for anything else", () => {
    expect(validTiersFor("nba-top-shot")).toBe(VALID_TIERS)
    expect(validTiersFor("bogus")).toBe(VALID_TIERS)
    expect(validTiersFor("nba-top-shot").has("FANDOM")).toBe(true)
  })

  it("the two tier vocabularies differ on FANDOM vs UNCOMMON", () => {
    expect(VALID_TIERS.has("FANDOM")).toBe(true)
    expect(VALID_TIERS.has("UNCOMMON")).toBe(false)
    expect(VALID_TIERS_ALLDAY.has("UNCOMMON")).toBe(true)
    expect(VALID_TIERS_ALLDAY.has("FANDOM")).toBe(false)
  })
})
