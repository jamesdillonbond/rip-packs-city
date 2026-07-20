import { describe, it, expect } from "vitest"
import {
  filterSniperDeals,
  sortByVerifiedFirst,
  computeSniperStats,
  isDealOwned,
} from "@/lib/sniper/helpers"
import type { SniperDeal } from "@/lib/sniper/types"

// Unit tests for the sniper page's deal-list shaping (filter → verified-first
// demote → headline stats), extracted from the 1,700-line client component so it
// can be driven directly. Pins the two decisions that shape what the user sees:
//   1. negative-discount rows + Verified-only + owned gate are applied together;
//   2. "hot"/avgDiscount count only VERIFIED deals so thin-FMV fake bargains
//      can't inflate the headline numbers.

const DEAL_BASE = {
  momentId: "m",
  editionKey: "1:2",
  intEditionKey: null,
  playerName: "Luka Doncic",
  teamName: "Mavericks",
  setName: "Base Set",
  tier: "COMMON",
  serial: 1,
  askPrice: 10,
  adjustedFmv: 20,
  discount: 50,
  confidence: "HIGH",
  confidenceSource: undefined,
  hasBadge: false,
  isSpecialSerial: false,
  lowConfidenceFmv: false,
}

function deal(over: Partial<SniperDeal> = {}): SniperDeal {
  return { ...DEAL_BASE, ...over } as unknown as SniperDeal
}

const verified = (over: Partial<SniperDeal> = {}) => deal({ confidence: "HIGH", lowConfidenceFmv: false, confidenceSource: undefined, ...over })
const thin = (over: Partial<SniperDeal> = {}) => deal({ confidence: "LOW", ...over })

describe("filterSniperDeals", () => {
  it("drops negative-discount rows", () => {
    const out = filterSniperDeals([deal({ discount: -5 }), deal({ discount: 10 })])
    expect(out).toHaveLength(1)
    expect(out[0].discount).toBe(10)
  })

  it("applies the search box across player, set, and team (case-insensitive)", () => {
    const deals = [
      deal({ playerName: "Luka Doncic" }),
      deal({ playerName: "Jokic", setName: "Metallic Gold" }),
      deal({ playerName: "Embiid", teamName: "76ers" }),
      deal({ playerName: "Tatum", setName: "Base", teamName: "Celtics" }),
    ]
    expect(filterSniperDeals(deals, { search: "luka" })).toHaveLength(1)
    expect(filterSniperDeals(deals, { search: "GOLD" })).toHaveLength(1) // set match, case-insensitive
    expect(filterSniperDeals(deals, { search: "76ers" })).toHaveLength(1) // team match
    expect(filterSniperDeals(deals, { search: "nobody" })).toHaveLength(0)
  })

  it("Verified-only hides thin/low-confidence deals", () => {
    const deals = [verified(), thin(), verified()]
    expect(filterSniperDeals(deals, { showVerifiedOnly: true })).toHaveLength(2)
    expect(filterSniperDeals(deals, { showVerifiedOnly: false })).toHaveLength(3)
  })

  it("owned/not-owned gate checks both the int-pair and legacy edition keys", () => {
    const owned = new Set(["1:2"])
    const deals = [
      deal({ editionKey: "1:2" }), // owned via legacy key
      deal({ editionKey: "x", intEditionKey: "1:2" }), // owned via int key
      deal({ editionKey: "9:9", intEditionKey: null }), // not owned
    ]
    expect(filterSniperDeals(deals, { ownedFilter: "owned", ownedIds: owned })).toHaveLength(2)
    expect(filterSniperDeals(deals, { ownedFilter: "not-owned", ownedIds: owned })).toHaveLength(1)
    expect(filterSniperDeals(deals, { ownedFilter: "all", ownedIds: owned })).toHaveLength(3)
  })

  it("owned gate with no ownedIds provided treats everything as not-owned", () => {
    const deals = [deal({ editionKey: "1:2" })]
    expect(filterSniperDeals(deals, { ownedFilter: "owned" })).toHaveLength(0)
    expect(filterSniperDeals(deals, { ownedFilter: "not-owned" })).toHaveLength(1)
  })

  it("does not mutate the input array", () => {
    const deals = [deal({ discount: -1 }), deal()]
    const copy = [...deals]
    filterSniperDeals(deals)
    expect(deals).toEqual(copy)
  })
})

describe("isDealOwned", () => {
  it("true when either key form is in the owned set", () => {
    expect(isDealOwned(deal({ editionKey: "1:2", intEditionKey: null }), new Set(["1:2"]))).toBe(true)
    expect(isDealOwned(deal({ editionKey: "x", intEditionKey: "7:8" }), new Set(["7:8"]))).toBe(true)
  })
  it("false when neither key matches", () => {
    expect(isDealOwned(deal({ editionKey: "1:2" }), new Set(["9:9"]))).toBe(false)
  })
})

describe("sortByVerifiedFirst", () => {
  it("moves verified deals ahead of thin ones, preserving input order within a group (stable)", () => {
    const a = verified({ momentId: "a" })
    const b = thin({ momentId: "b" })
    const c = verified({ momentId: "c" })
    const d = thin({ momentId: "d" })
    const out = sortByVerifiedFirst([b, a, d, c])
    // verified (a, c) first in their original relative order, then thin (b, d)
    expect(out.map((x) => x.momentId)).toEqual(["a", "c", "b", "d"])
  })
  it("returns a new array (no mutation)", () => {
    const deals = [thin(), verified()]
    const copy = [...deals]
    sortByVerifiedFirst(deals)
    expect(deals).toEqual(copy)
  })
})

describe("computeSniperStats", () => {
  it("total/badge/special count the full visible set; hot/avgDiscount only the verified subset", () => {
    const deals = [
      verified({ discount: 60, hasBadge: true, isSpecialSerial: true }),
      verified({ discount: 20 }),
      thin({ discount: 90, hasBadge: true }), // thin: excluded from hot + avg, counted in badge/total
    ]
    const s = computeSniperStats(deals)
    expect(s.total).toBe(3)
    expect(s.badge).toBe(2) // both hasBadge, thin included
    expect(s.special).toBe(1)
    expect(s.hot).toBe(1) // only the verified discount>=40 (the thin 90% doesn't count)
    expect(s.avgDiscount).toBe(40) // (60 + 20) / 2 verified only
  })
  it("avgDiscount is 0 when there are no verified deals", () => {
    const s = computeSniperStats([thin({ discount: 80 })])
    expect(s.avgDiscount).toBe(0)
    expect(s.hot).toBe(0)
    expect(s.total).toBe(1)
  })
  it("empty input → all zeros", () => {
    expect(computeSniperStats([])).toEqual({ total: 0, hot: 0, badge: 0, special: 0, avgDiscount: 0 })
  })
})
