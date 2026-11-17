import { describe, it, expect } from "vitest"
import {
  isSupportedPackCollection,
  SUPPORTED_PACK_COLLECTIONS,
} from "@/lib/packs/live-pack-listings"

// Guards the live-pack-listings collection whitelist. Only Top Shot + All Day
// have a primary-pack reserve config; other slugs must be rejected so a bad
// slug can't reach the listings query.

describe("isSupportedPackCollection", () => {
  it("accepts the configured pack collections", () => {
    expect(isSupportedPackCollection("nba-top-shot")).toBe(true)
    expect(isSupportedPackCollection("nfl-all-day")).toBe(true)
  })

  it("rejects collections with no primary-pack config", () => {
    expect(isSupportedPackCollection("disney-pinnacle")).toBe(false)
    expect(isSupportedPackCollection("ufc")).toBe(false)
    expect(isSupportedPackCollection("laliga-golazos")).toBe(false)
    expect(isSupportedPackCollection("bogus")).toBe(false)
  })

  it("SUPPORTED_PACK_COLLECTIONS lists exactly the two configured slugs", () => {
    expect([...SUPPORTED_PACK_COLLECTIONS].sort()).toEqual(["nba-top-shot", "nfl-all-day"])
  })
})
