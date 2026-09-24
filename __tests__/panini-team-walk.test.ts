// __tests__/panini-team-walk.test.ts
//
// The pure parts of scripts/panini-team-walk.mjs. The walk itself needs a browser and
// Panini; what CAN be pinned here is what decides correctness:
//   - which network response is the grid's `products` answer (the end-of-list signal
//     is an EMPTY products response — reading the wrong op would end a walk early and
//     let it retire live listings),
//   - the target parser (a typo must fail loudly, not walk nothing and report success),
//   - the row mapper (a malformed item is dropped, never written with a fabricated key).

import { describe, expect, it } from "vitest"
import {
  DEFAULT_TARGETS,
  MAX_PAGE_ATTEMPTS,
  isProductsResponse,
  pageUrl,
  parseTargets,
  retryBackoffMs,
  toRow,
} from "../scripts/panini-team-walk.mjs"

describe("retryBackoffMs", () => {
  // The first laptop run lost Blazers at p15 to two BACK-TO-BACK throttled answers.
  it("does not wait before the first try, and waits longer before every later retry", () => {
    expect(retryBackoffMs(1)).toBe(0)
    let prev = 0
    for (let a = 3; a <= MAX_PAGE_ATTEMPTS; a++) {
      expect(retryBackoffMs(a)).toBeGreaterThan(prev)
      prev = retryBackoffMs(a)
    }
    expect(MAX_PAGE_ATTEMPTS).toBeGreaterThanOrEqual(3)
    expect(retryBackoffMs(3)).toBeGreaterThanOrEqual(15_000)
  })
})

describe("parseTargets", () => {
  it("parses the default pilot targets", () => {
    expect(parseTargets(DEFAULT_TARGETS)).toEqual([
      { sport: "Basketball", team: "Portland Trail Blazers" },
      { sport: "Baseball", team: "Detroit" },
    ])
  })
  it("rejects an empty list, a missing team, and an unsupported sport", () => {
    expect(() => parseTargets("")).toThrow(/empty/)
    expect(() => parseTargets("Basketball:")).toThrow(/bad/)
    expect(() => parseTargets("Soccer:Brazil")).toThrow(/unsupported sport/)
  })
})

describe("pageUrl", () => {
  it("encodes the team filter and page", () => {
    expect(pageUrl("Basketball", "Portland Trail Blazers", 3)).toBe(
      "https://nft.paniniamerica.net/marketplace/nfts.html?sport=Basketball&team=Portland+Trail+Blazers&p=3",
    )
  })
})

describe("isProductsResponse", () => {
  it("accepts only the products operation on /onepanini", () => {
    expect(isProductsResponse("https://x/onepanini", JSON.stringify({ operationName: "products" }))).toBe(true)
    expect(isProductsResponse("https://x/onepanini", JSON.stringify({ operationName: "getCardMarketStats" }))).toBe(false)
    expect(isProductsResponse("https://x/graphql", JSON.stringify({ operationName: "products" }))).toBe(false)
    expect(isProductsResponse("https://x/onepanini", "not json")).toBe(false)
    expect(isProductsResponse("https://x/onepanini", null)).toBe(false)
  })
})

describe("toRow", () => {
  it("maps a grid item, preferring the buy-now price", () => {
    expect(
      toRow({
        sku: "packcard-1783_1_2_3__2_10",
        psku: "packcard-1783_1_2_3",
        team: "Portland Trail Blazers",
        athlete: "Scoot Henderson",
        cardset: "Base",
        genesis_year: "2024",
        rarity: "Epic",
        end_seq: 10,
        buy_now_price: "8.00",
        price: 99,
        nft_type: null,
      }),
    ).toEqual({
      sku: "packcard-1783_1_2_3__2_10",
      psku: "packcard-1783_1_2_3",
      team: "Portland Trail Blazers",
      athlete: "Scoot Henderson",
      cardset: "Base",
      genesis_year: 2024,
      rarity: "Epic",
      end_seq: 10,
      price_usd: 8,
      nft_type: null,
    })
  })
  it("drops an item with no sku or psku instead of inventing one", () => {
    expect(toRow({ psku: "p" })).toBeNull()
    expect(toRow({ sku: "s" })).toBeNull()
    expect(toRow(null)).toBeNull()
  })
  it("keeps an unparseable number NULL, never 0", () => {
    const r = toRow({ sku: "s", psku: "p", genesis_year: "n/a", end_seq: "", buy_now_price: null, final_price: undefined, price: "x" })
    expect(r).toMatchObject({ genesis_year: null, end_seq: null, price_usd: null })
  })
})
