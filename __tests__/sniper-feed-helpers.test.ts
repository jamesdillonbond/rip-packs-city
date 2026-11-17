import { describe, it, expect } from "vitest"
import {
  parseListingPrice,
  extractBadgeSlugs,
  BADGE_LABELS,
  KNOWN_BADGES,
  sortSniperDeals,
  mergeDedupeByEditionKey,
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

describe("sortSniperDeals — sort key contract", () => {
  const deal = (o: Partial<Parameters<typeof sortSniperDeals>[0][number]> & { id: string }) => ({
    askPrice: 0,
    adjustedFmv: 0,
    serial: 0,
    discount: 0,
    updatedAt: null,
    ...o,
  })
  const ids = (arr: Array<{ id: string }>) => arr.map((d) => d.id)

  it("price_asc / price_desc order by askPrice", () => {
    const d = [deal({ id: "a", askPrice: 30 }), deal({ id: "b", askPrice: 10 }), deal({ id: "c", askPrice: 20 })]
    expect(ids(sortSniperDeals([...d], "price_asc"))).toEqual(["b", "c", "a"])
    expect(ids(sortSniperDeals([...d], "price_desc"))).toEqual(["a", "c", "b"])
  })

  it("fmv_desc orders by adjustedFmv descending", () => {
    const d = [deal({ id: "a", adjustedFmv: 5 }), deal({ id: "b", adjustedFmv: 50 })]
    expect(ids(sortSniperDeals(d, "fmv_desc"))).toEqual(["b", "a"])
  })

  it("serial_asc orders by serial ascending", () => {
    const d = [deal({ id: "a", serial: 9 }), deal({ id: "b", serial: 1 })]
    expect(ids(sortSniperDeals(d, "serial_asc"))).toEqual(["b", "a"])
  })

  it("listed_desc orders by newest updatedAt, treating null as epoch", () => {
    const d = [
      deal({ id: "old", updatedAt: "2020-01-01T00:00:00Z" }),
      deal({ id: "new", updatedAt: "2026-01-01T00:00:00Z" }),
      deal({ id: "null", updatedAt: null }),
    ]
    expect(ids(sortSniperDeals(d, "listed_desc"))).toEqual(["new", "old", "null"])
  })

  it("unknown/default sort key falls back to discount descending", () => {
    const d = [deal({ id: "a", discount: 5 }), deal({ id: "b", discount: 40 })]
    expect(ids(sortSniperDeals(d, "discount"))).toEqual(["b", "a"])
    expect(ids(sortSniperDeals(d, "whatever"))).toEqual(["b", "a"])
  })

  it("sorts in place and returns the same array reference", () => {
    const d = [deal({ id: "a", discount: 1 })]
    expect(sortSniperDeals(d, "discount")).toBe(d)
  })
})

describe("mergeDedupeByEditionKey — RPC-first dedup", () => {
  it("keeps the RPC row on an editionKey collision (RPC passed first wins)", () => {
    const rpc = [{ editionKey: "26:504", flowId: "r1", src: "rpc" }]
    const gql = [{ editionKey: "26:504", flowId: "g1", src: "gql" }]
    const out = mergeDedupeByEditionKey(rpc, gql)
    expect(out).toHaveLength(1)
    expect(out[0].src).toBe("rpc")
  })

  it("falls back through intEditionKey then flowId for the dedup key", () => {
    const rpc = [{ flowId: "shared", intEditionKey: "1:2", src: "rpc" }]
    const gql = [{ flowId: "shared", intEditionKey: "1:2", src: "gql" }]
    expect(mergeDedupeByEditionKey(rpc, gql)).toHaveLength(1)
  })

  it("drops rows with no usable key", () => {
    const gql = [{ flowId: "", src: "keyless" }]
    expect(mergeDedupeByEditionKey([], gql)).toEqual([])
  })

  it("passes distinct keys through in RPC-then-GQL order", () => {
    const rpc = [{ editionKey: "a", flowId: "r" }]
    const gql = [{ editionKey: "b", flowId: "g" }]
    expect(mergeDedupeByEditionKey(rpc, gql).map((d) => d.editionKey)).toEqual(["a", "b"])
  })
})
