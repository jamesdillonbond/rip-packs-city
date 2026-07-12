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
