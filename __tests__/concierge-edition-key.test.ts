import { describe, it, expect } from "vitest"
import { editionKeyCollectionMismatch } from "@/lib/concierge/edition-key"

// Locks the concierge edition-key ↔ collection vocabulary guard (CLAUDE.md
// footgun): Top Shot uses numeric setID:playID keys, Disney Pinnacle uses
// opaque string keys. A key of the wrong shape for the active collection
// silently mis-queries, so the guard must flag it as wrong_collection.

describe("editionKeyCollectionMismatch", () => {
  it("returns null when the key is missing / non-string / no active collection", () => {
    expect(editionKeyCollectionMismatch(null, "nba-top-shot")).toBeNull()
    expect(editionKeyCollectionMismatch(undefined, "nba-top-shot")).toBeNull()
    expect(editionKeyCollectionMismatch("", "nba-top-shot")).toBeNull()
    expect(editionKeyCollectionMismatch(123, "nba-top-shot")).toBeNull()
    expect(editionKeyCollectionMismatch("73:2785", null)).toBeNull()
    expect(editionKeyCollectionMismatch("73:2785", undefined)).toBeNull()
  })

  it("accepts a well-formed Top Shot key on Top Shot", () => {
    expect(editionKeyCollectionMismatch("73:2785", "nba-top-shot")).toBeNull()
  })

  // 2026-11-12, live: asked to explain the price on a parallel's own page (281:9386::17), the tool was
  // refused here in 10 ms and the concierge said "the detailed breakdown didn't run for this edition key".
  it("accepts a Top Shot parallel key (setID:playID::subID) on Top Shot, and still refuses a malformed one", () => {
    expect(editionKeyCollectionMismatch("281:9386::17", "nba-top-shot")).toBeNull()
    expect(editionKeyCollectionMismatch("281:9386::", "nba-top-shot")?.status).toBe("wrong_collection")
    expect(editionKeyCollectionMismatch("281:9386:17", "nba-top-shot")?.status).toBe("wrong_collection")
    // a parallel key is still a Top Shot shape, so Pinnacle refuses it
    expect(editionKeyCollectionMismatch("281:9386::17", "disney-pinnacle")?.status).toBe("wrong_collection")
  })

  it("flags a non-setID:playID key on Top Shot", () => {
    const r = editionKeyCollectionMismatch("some-opaque-key", "nba-top-shot")
    expect(r).not.toBeNull()
    expect(r!.status).toBe("wrong_collection")
    expect(r!.message).toContain("setID:playID")
    // echoes the offending key back to the model
    expect(r!.message).toContain("some-opaque-key")
  })

  it("flags a Top Shot-shaped key on Disney Pinnacle", () => {
    const r = editionKeyCollectionMismatch("73:2785", "disney-pinnacle")
    expect(r).not.toBeNull()
    expect(r!.status).toBe("wrong_collection")
    expect(r!.message).toContain("Disney Pinnacle uses opaque")
  })

  it("accepts an opaque key on Disney Pinnacle", () => {
    expect(
      editionKeyCollectionMismatch("royalty:variant:1", "disney-pinnacle")
    ).toBeNull()
  })

  it("does not police collections without a shape rule (e.g. All Day)", () => {
    // Only Top Shot and Pinnacle have edition-key shape guards; other
    // collections pass through so the guard never blocks a legitimate query.
    expect(editionKeyCollectionMismatch("73:2785", "nfl-all-day")).toBeNull()
    expect(editionKeyCollectionMismatch("anything", "nfl-all-day")).toBeNull()
  })
})
