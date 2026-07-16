import { describe, it, expect } from "vitest"
import {
  parseListingPrice,
  extractBadgeSlugs,
  BADGE_LABELS,
  KNOWN_BADGES,
} from "@/lib/sniper/feed-helpers"

// Unit tests for the pure listing/badge helpers extracted from the 1,590-line
// sniper-feed route (which itself can't be driven end-to-end because of its
// live TopShot/AllDay GraphQL fan-out). These pin the price-field priority
// order and the badge-slug normalization that the feed relies on.

describe("parseListingPrice — field priority", () => {
  it("prefers a positive marketplacePrice above all else", () => {
    expect(
      parseListingPrice({ marketplacePrice: 42, flowRetailPrice: { value: "99" }, lowAsk: 5 }),
    ).toBe(42)
  })

  it("falls back to flowRetailPrice when marketplacePrice is absent", () => {
    expect(parseListingPrice({ flowRetailPrice: { value: "12.5" }, lowAsk: 5 })).toBe(12.5)
  })

  it("falls back to lowAsk when neither price field is usable", () => {
    expect(parseListingPrice({ lowAsk: 7 })).toBe(7)
  })

  it("ignores a zero or negative marketplacePrice and continues down the chain", () => {
    expect(parseListingPrice({ marketplacePrice: 0, flowRetailPrice: { value: "8" } })).toBe(8)
    expect(parseListingPrice({ marketplacePrice: -3, lowAsk: 4 })).toBe(4)
  })

  it("ignores a non-positive or non-numeric flowRetailPrice string", () => {
    expect(parseListingPrice({ flowRetailPrice: { value: "0" }, lowAsk: 9 })).toBe(9)
    expect(parseListingPrice({ flowRetailPrice: { value: "not-a-number" }, lowAsk: 9 })).toBe(9)
  })

  it("returns 0 when no field yields a positive price", () => {
    expect(parseListingPrice({})).toBe(0)
    expect(parseListingPrice({ marketplacePrice: 0, lowAsk: 0 })).toBe(0)
  })
})

describe("extractBadgeSlugs — normalization", () => {
  it("returns [] for undefined or empty tags", () => {
    expect(extractBadgeSlugs(undefined)).toEqual([])
    expect(extractBadgeSlugs([])).toEqual([])
  })

  it("keeps recognized slug-form ids", () => {
    expect(extractBadgeSlugs([{ id: "rookie_mint" }, { id: "mvp" }])).toEqual([
      "rookie_mint",
      "mvp",
    ])
  })

  it("matches on title when id is absent or unknown", () => {
    expect(extractBadgeSlugs([{ title: "Rookie of the Year" }])).toEqual(["Rookie of the Year"])
    expect(extractBadgeSlugs([{ id: "bogus", title: "Fresh" }])).toEqual(["Fresh"])
  })

  it("prefers id over title when both are recognized", () => {
    expect(extractBadgeSlugs([{ id: "rookie_year", title: "Fresh" }])).toEqual(["rookie_year"])
  })

  it("drops tags that match neither id nor title", () => {
    expect(extractBadgeSlugs([{ id: "unknown_thing" }, { title: "Also Unknown" }])).toEqual([])
  })

  it("every produced slug resolves to a label via BADGE_LABELS", () => {
    const slugs = extractBadgeSlugs([{ id: "top_shot_debut" }, { title: "Championship Year" }])
    for (const s of slugs) expect(BADGE_LABELS[s]).toBeDefined()
  })
})

describe("KNOWN_BADGES / BADGE_LABELS invariants", () => {
  it("KNOWN_BADGES is exactly the key set of BADGE_LABELS", () => {
    expect(KNOWN_BADGES.size).toBe(Object.keys(BADGE_LABELS).length)
    for (const k of Object.keys(BADGE_LABELS)) expect(KNOWN_BADGES.has(k)).toBe(true)
  })
})
