import { describe, expect, it } from "vitest"
import {
  collectionViewStorageKey,
  legacySharedFilterKey,
  SCOPED_VIEW_FIELDS,
  SHARED_VIEW_FIELDS,
} from "@/lib/collection-view-storage"

describe("collection view storage keys", () => {
  it("gives every filter field a different key per collection", () => {
    for (const f of SCOPED_VIEW_FIELDS) {
      const a = collectionViewStorageKey("nba-top-shot", f)
      const b = collectionViewStorageKey("laliga-golazos", f)
      expect(a).not.toBe(b)
      expect(a).toContain("nba-top-shot")
      // never the pre-11-10 shared key, which is what leaked a filter across collections
      expect(a).not.toBe(legacySharedFilterKey(f))
      expect(b).not.toBe(legacySharedFilterKey(f))
    }
  })

  it("keeps the sort preference shared", () => {
    for (const f of SHARED_VIEW_FIELDS) {
      expect(collectionViewStorageKey("nba-top-shot", f)).toBe(collectionViewStorageKey("candy-mlb", f))
    }
  })

  it("covers the six filters the tab persists", () => {
    expect([...SCOPED_VIEW_FIELDS].sort()).toEqual(
      ["badgeFilter", "lockedFilter", "playerFilter", "rarityFilter", "seriesFilter", "setFilter"],
    )
  })
})
