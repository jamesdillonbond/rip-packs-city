import { describe, it, expect } from "vitest"
import {
  allMarketplaceFees,
  feeNetDeal,
  feeOnSale,
  netProceeds,
  sellerFeeFor,
} from "@/lib/marketplace-fees"

// Unit tests for the published-fee table and the deal math on top of it.
//
// Two things matter here beyond arithmetic:
//  1. The table is a set of QUOTED, SOURCED rates. The pins below exist so that
//     a rate cannot be edited casually — if an operator changes its fee, the
//     change should be a deliberate edit with a re-verified source, not a
//     silent drift.
//  2. Everything returns null rather than a guess when a rate is unverified.
//     A fabricated fee on a money surface is worse than no column at all.

describe("the fee table is pinned to its sources", () => {
  it("the four Dapper Flow marketplaces are 5% with no listing-fee floor", () => {
    for (const slug of ["nba_top_shot", "nfl_all_day", "laliga_golazos", "ufc_strike"]) {
      const f = sellerFeeFor(slug)!
      expect(f, slug).toBeTruthy()
      expect(f.pct, slug).toBe(0.05)
      expect(f.minFeeUsd, slug).toBe(0)
    }
  })

  it("Disney Pinnacle is 7.5% with a $0.50 floor, and is flagged provisional", () => {
    const f = sellerFeeFor("disney_pinnacle")!
    expect(f.pct).toBe(0.075)
    expect(f.minFeeUsd).toBe(0.5)
    expect(f.provisional).toBe(true)
  })

  it("every entry carries a source URL and a verification date", () => {
    for (const f of allMarketplaceFees()) {
      expect(f.sourceUrl, f.collectionSlug).toMatch(/^https:\/\//)
      expect(f.verifiedOn, f.collectionSlug).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it("resolves the hyphenated and short slug vocabularies too", () => {
    expect(sellerFeeFor("nba-top-shot")?.collectionSlug).toBe("nba_top_shot")
    expect(sellerFeeFor("topshot")?.collectionSlug).toBe("nba_top_shot")
    expect(sellerFeeFor("disney-pinnacle")?.collectionSlug).toBe("disney_pinnacle")
    expect(sellerFeeFor("ALLDAY")?.collectionSlug).toBe("nfl_all_day")
    expect(sellerFeeFor("golazos")?.collectionSlug).toBe("laliga_golazos")
    expect(sellerFeeFor("ufc")?.collectionSlug).toBe("ufc_strike")
  })

  it("returns null for a collection with no verified rate", () => {
    // Magic Eden's taker/royalty split is a different shape from a flat Dapper
    // seller fee — it needs its own model, not a copied 5%.
    expect(sellerFeeFor("candy_mlb")).toBeNull()
    expect(sellerFeeFor("panini")).toBeNull()
    expect(sellerFeeFor("")).toBeNull()
    expect(sellerFeeFor(null)).toBeNull()
  })
  it("returns null for a prototype-key slug (SLUG_ALIASES own-property guarded)", () => {
    for (const key of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
      expect(sellerFeeFor(key)).toBeNull()
    }
  })
})

describe("feeOnSale / netProceeds", () => {
  const ts = sellerFeeFor("nba_top_shot")!
  const pin = sellerFeeFor("disney_pinnacle")!

  it("matches the operator's own worked example ($10 listing pays $9.50)", () => {
    expect(netProceeds(10, ts)).toBe(9.5)
  })

  it("treats Pinnacle's listing fee as a FLOOR, not an addition", () => {
    // Above the crossover (0.075 * p > 0.50, i.e. p > $6.67) the percentage rules.
    expect(feeOnSale(100, pin)).toBeCloseTo(7.5, 6)
    // Below it, the $0.50 credited listing fee is what you actually pay.
    expect(feeOnSale(4, pin)).toBe(0.5)
    // Not 0.50 + 0.30.
    expect(feeOnSale(4, pin)).not.toBeCloseTo(0.8, 6)
  })

  it("on a $1 pin the floor is half the sale — the case the column exists for", () => {
    expect(netProceeds(1, pin)).toBe(0.5)
  })

  it("never returns a negative payout", () => {
    expect(netProceeds(0.1, pin)).toBe(0)
    expect(netProceeds(0, pin)).toBe(0)
    expect(netProceeds(-5, pin)).toBe(0)
  })
})

describe("feeNetDeal", () => {
  it("computes net proceeds, margin on the ask, and the gross headline", () => {
    // $100 FMV, $80 ask, Top Shot 5%: keep $95, margin $15 on $80 = 18.8%.
    const d = feeNetDeal(80, 100, "nba_top_shot")!
    expect(d.netIfResold).toBe(95)
    expect(d.netMarginUsd).toBe(15)
    expect(d.netMarginPct).toBe(18.8)
    expect(d.grossDiscountPct).toBe(20)
    expect(d.flipsNegative).toBe(false)
  })

  it("flags a gross discount that does NOT survive fees", () => {
    // $100 FMV, $97 ask: a 3% gross "discount", but 5% of FMV is $5.
    const d = feeNetDeal(97, 100, "nba_top_shot")!
    expect(d.grossDiscountPct).toBe(3)
    expect(d.netMarginUsd).toBeLessThan(0)
    expect(d.flipsNegative).toBe(true)
  })

  it("catches the Pinnacle small-ticket case the 5% assumption would miss", () => {
    // $2 FMV, $1 ask — a 50% gross discount. The $0.50 floor takes a quarter of
    // the resale, leaving $1.50 against a $1 ask.
    const d = feeNetDeal(1, 2, "disney_pinnacle")!
    expect(d.grossDiscountPct).toBe(50)
    expect(d.netIfResold).toBe(1.5)
    expect(d.netMarginUsd).toBe(0.5)
    // Under a naive 5% assumption you'd have claimed $1.90 net.
    expect(d.netIfResold).not.toBe(1.9)
  })

  it("Pinnacle's higher rate yields a strictly worse net than Top Shot's at the same prices", () => {
    const a = feeNetDeal(80, 100, "nba_top_shot")!
    const b = feeNetDeal(80, 100, "disney_pinnacle")!
    expect(b.netIfResold).toBeLessThan(a.netIfResold)
    expect(b.netMarginPct).toBeLessThan(a.netMarginPct)
  })

  it("returns null — not zero — on missing or non-positive inputs", () => {
    expect(feeNetDeal(null, 100, "nba_top_shot")).toBeNull()
    expect(feeNetDeal(80, null, "nba_top_shot")).toBeNull()
    expect(feeNetDeal(0, 100, "nba_top_shot")).toBeNull()
    expect(feeNetDeal(80, 0, "nba_top_shot")).toBeNull()
  })

  it("returns null for an unverified collection rather than assuming 5%", () => {
    expect(feeNetDeal(80, 100, "candy_mlb")).toBeNull()
  })
})
