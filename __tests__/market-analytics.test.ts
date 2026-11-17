import { describe, it, expect } from "vitest"
import {
  buildMarketSnapshot,
  type SnapshotInput,
  type UnifiedMarketTruth,
} from "@/lib/market-analytics"

// Pins lib/market-analytics.ts::buildMarketSnapshot — the deterministic engine
// that reconciles TopShot/Flowty/Flowscan asks/offers/sales into the per-moment
// MarketSnapshot every market surface renders. The function is PURE (no I/O; it
// depends only on its input plus the FLOWTY_MARKETPLACE_ENABLED build flag), so
// a refactor that silently changes the FMV method, anchor selection, market
// status classification, or best-marketplace routing will fail here.
//
// Some outputs (confidence, ASP jitter, the fallback-offer coin flip) are seeded
// off a hash of momentId/editionKey/parallel and are therefore stable-but-opaque
// per key; those are asserted as invariants (valid enum / finite / bounded)
// rather than exact values. Everything driven by an explicit `truth` object is
// deterministic and asserted exactly, because a supplied truth overrides the
// seed-based fallbacks for ask/offer/sale.

function truth(over: Partial<UnifiedMarketTruth> = {}): UnifiedMarketTruth {
  return {
    marketKey: "233:8121",
    marketBackedAsk: null,
    marketBackedLastSale: null,
    marketBackedBestOffer: null,
    topShotAsk: null,
    flowtyAsk: null,
    topShotBestOffer: null,
    flowtyBestOffer: null,
    flowscanLatestSale: null,
    flowscanRecentSales: [],
    flowscanAverageRecentSale: null,
    flowscanSaleCount7d: null,
    flowscanSaleCount30d: null,
    observedSourceCount: 0,
    probeStatus: "observed-only",
    sourceSummary: "test",
    probeNotes: [],
    ...over,
  }
}

function input(over: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    momentId: 12345,
    editionKey: "233:8121",
    parallel: null,
    bestAsk: null,
    lastPurchasePrice: null,
    specialSerialTraits: [],
    ...over,
  }
}

const CONFIDENCES = ["low", "medium", "high"]

describe("buildMarketSnapshot — determinism & structure", () => {
  it("is a pure function of its input (same input → identical snapshot)", () => {
    const a = buildMarketSnapshot(input({ momentId: "abc", bestAsk: 50 }))
    const b = buildMarketSnapshot(input({ momentId: "abc", bestAsk: 50 }))
    expect(a).toEqual(b)
  })

  it("stringifies momentId and always emits a valid confidence bucket", () => {
    const snap = buildMarketSnapshot(input({ momentId: 999 }))
    expect(snap.momentId).toBe("999")
    expect(CONFIDENCES).toContain(snap.confidence)
  })
})

describe("buildMarketSnapshot — anchor selection", () => {
  it("ask + sale blends 30/70 toward the sale and reports the observed count", () => {
    const snap = buildMarketSnapshot(
      input({
        truth: truth({ marketBackedAsk: 100, marketBackedLastSale: 200, observedSourceCount: 2 }),
      }),
    )
    expect(snap.anchorType).toBe("ask+sale")
    expect(snap.observedInputsCount).toBe(2)
    // 100*0.3 + 200*0.7 = 170
    expect(snap.anchorPrice).toBe(170)
  })

  it("sale-only (no ask) anchors on the sale", () => {
    const snap = buildMarketSnapshot(input({ truth: truth({ marketBackedLastSale: 88 }) }))
    expect(snap.anchorType).toBe("sale")
    expect(snap.anchorPrice).toBe(88)
  })

  it("an ask always blends with the derived last-purchase (never a bare ask anchor)", () => {
    // `lastPurchase` falls back to the modeled base when no sale is observed, so
    // whenever an ask is present the anchor is the ask+sale blend, not "ask".
    const snap = buildMarketSnapshot(input({ truth: truth({ marketBackedAsk: 42 }) }))
    expect(snap.anchorType).toBe("ask+sale")
    expect(snap.marketBackedAsk).toBe(42)
  })

  it("no ask and no sale still anchors on the modeled base (deterministic, non-null)", () => {
    const snap = buildMarketSnapshot(input())
    expect(snap.anchorType).toBe("sale")
    expect(snap.anchorPrice).not.toBeNull()
  })
})

describe("buildMarketSnapshot — market status classification", () => {
  it("no ask → No Ask (offer present) or Illiquid (no offer)", () => {
    // With no ask supplied, best offer resolves either to the truth value or the
    // seeded fallback, so the status is one of the two no-ask terminals. Both
    // share hasAsk=false; the fully-deterministic No Ask case is pinned below.
    const snap = buildMarketSnapshot(
      input({ momentId: "illiquid-probe", truth: truth({ marketBackedAsk: null }) }),
    )
    expect(["No Ask", "Illiquid"]).toContain(snap.marketStatus)
    expect(snap.hasAsk).toBe(false)
  })

  it("no ask but a market-backed best offer → No Ask", () => {
    const snap = buildMarketSnapshot(
      input({ truth: truth({ marketBackedAsk: null, marketBackedBestOffer: 25 }) }),
    )
    expect(snap.marketStatus).toBe("No Ask")
    expect(snap.hasAsk).toBe(false)
    expect(snap.hasBestOffer).toBe(true)
    expect(snap.bestOffer).toBe(25)
    expect(snap.bestOfferSource).toBe("Top Shot Truth")
  })

  it("ask present with a near-equal chain sale → Fair (fmv close to ask)", () => {
    // offer > ask forces the deterministic ask-anchored FMV path (confidence-free):
    // baseFmv = min(ask, ask*0.74 + avgSale*0.26). avg==ask → fmv==ask → premium 0 → Fair.
    const snap = buildMarketSnapshot(
      input({
        truth: truth({
          marketBackedAsk: 100,
          marketBackedBestOffer: 300,
          flowscanAverageRecentSale: 100,
        }),
      }),
    )
    expect(snap.fmvMethod).toBe("lowest ask + chain avg sale")
    expect(snap.marketStatus).toBe("Fair")
    expect(snap.premiumPct === null || snap.premiumPct <= 5).toBe(true)
  })

  it("ask far above the chain sale → Premium (fmv well below ask)", () => {
    const snap = buildMarketSnapshot(
      input({
        truth: truth({
          marketBackedAsk: 100,
          marketBackedBestOffer: 300,
          flowscanAverageRecentSale: 10,
        }),
      }),
    )
    // fmv = min(100, 74 + 2.6) = 76.6 → premium (100-76.6)/76.6 ≈ 30.5% > 5
    expect(snap.fmvMid).toBeCloseTo(76.6, 1)
    expect(snap.marketStatus).toBe("Premium")
    expect(snap.premiumPct).toBeGreaterThan(5)
  })
})

describe("buildMarketSnapshot — FMV methods", () => {
  it("ask + chain latest (no avg) uses the chain-sale method", () => {
    const snap = buildMarketSnapshot(
      input({
        truth: truth({ marketBackedAsk: 100, marketBackedBestOffer: 300, flowscanLatestSale: 50 }),
      }),
    )
    expect(snap.fmvMethod).toBe("lowest ask + chain sale")
    // min(100, 78 + 11) = 89
    expect(snap.fmvMid).toBe(89)
  })

  it("ask + only a recent purchase uses the recent-sale method", () => {
    const snap = buildMarketSnapshot(
      input({
        lastPurchasePrice: 60,
        truth: truth({ marketBackedAsk: 100, marketBackedBestOffer: 300 }),
      }),
    )
    expect(snap.fmvMethod).toBe("lowest ask + recent sale")
    // min(100, 80 + 12) = 92
    expect(snap.fmvMid).toBe(92)
  })

  it("ask with only the modeled last-purchase blends via the recent-sale method and never exceeds the ask", () => {
    // No chain sale and no explicit lastPurchasePrice, but `lastPurchase` derives
    // to the modeled base (always non-null), so the recent-sale blend fires and
    // the min(ask, …) cap keeps FMV at or below the ask.
    const snap = buildMarketSnapshot(
      input({ truth: truth({ marketBackedAsk: 100, marketBackedBestOffer: 300 }) }),
    )
    expect(snap.fmvMethod).toBe("lowest ask + recent sale")
    expect(snap.fmvMid as number).toBeLessThanOrEqual(100)
    expect(snap.fmvMid as number).toBeGreaterThan(0)
  })

  it("offer <= ask engages the offer-ask band and never exceeds the ask", () => {
    const snap = buildMarketSnapshot(
      input({ truth: truth({ marketBackedAsk: 100, marketBackedBestOffer: 40 }) }),
    )
    expect(snap.fmvMethod).toBe("offer-ask band")
    expect(snap.fmvMid).not.toBeNull()
    expect(snap.fmvMid as number).toBeLessThanOrEqual(100)
    expect(snap.fmvMid as number).toBeGreaterThanOrEqual(40)
  })
})

describe("buildMarketSnapshot — special-serial premium", () => {
  it("#1 Serial applies the largest multiplier and flags the special method", () => {
    const base = buildMarketSnapshot(
      input({ momentId: "serialX", truth: truth({ marketBackedLastSale: 100 }) }),
    )
    const no1 = buildMarketSnapshot(
      input({
        momentId: "serialX",
        specialSerialTraits: ["#1 Serial"],
        truth: truth({ marketBackedLastSale: 100 }),
      }),
    )
    expect(no1.fmvMethod).toBe("special serial premium model")
    expect(no1.fmvMid).not.toBeNull()
    expect(base.fmvMid).not.toBeNull()
    // The #1 premium (×1.35) must value the moment above the plain blended model.
    expect(no1.fmvMid as number).toBeGreaterThan(base.fmvMid as number)
  })

  // ── THE MULTIPLIERS THEMSELVES ────────────────────────────────────────────
  //
  // ⚠ The two cases in this block above assert only RELATIVE ordering
  // ("greater than the plain model"). That is satisfied by ANY multiplier > 1,
  // so `#1 Serial` could drift from 1.35 to 1.53 — a 13% move on every #1 in the
  // catalogue — with the whole suite green. These are FMV-MOVING CONSTANTS on a
  // platform whose own rules make a pricing change Trevor's call, so the exact
  // factor is pinned. A legitimate re-fit SHOULD have to edit this test; that is
  // the point, not friction.
  //
  // The ratio is exact rather than base-dependent: `fmvCore` is
  // `applySerialPremium(base)` when special and `round2(base)` when not, off the
  // SAME base, so special/plain collapses to the multiplier (round2 on both
  // sides is why this is toBeCloseTo rather than toBe).
  //
  // ⚠ These deliberately do NOT match lib/serials/fun-patterns.ts, and must not
  // be "reconciled" with it. Those are NOVELTY quirks that carry no premium by
  // design (Trevor: "they don't get a value bump ... that's part of the
  // collecting experience"); these encode OBSERVED market premium. Folding
  // either into the other silently moves FMV for thousands of moments.
  it.each([
    ["#1 Serial", 1.35],
    ["Perfect Mint", 1.18],
    ["Jersey Match", 1.2],
    ["First Mint", 1.12],
    ["Last Mint", 1.08],
  ])("%s multiplies FMV by exactly %sx", (trait, expected) => {
    const plain = buildMarketSnapshot(
      input({ momentId: "mult", truth: truth({ marketBackedLastSale: 100 }) }),
    )
    const special = buildMarketSnapshot(
      input({
        momentId: "mult",
        specialSerialTraits: [trait as string],
        truth: truth({ marketBackedLastSale: 100 }),
      }),
    )
    expect(plain.fmvMid).not.toBeNull()
    expect(special.fmvMid).not.toBeNull()
    expect((special.fmvMid as number) / (plain.fmvMid as number)).toBeCloseTo(expected as number, 2)
  })

  it("stacking is MULTIPLICATIVE, not additive", () => {
    // 1.35 x 1.18 = 1.593, whereas an additive reading (1 + 0.35 + 0.18) gives
    // 1.53. Both are "bigger than either alone", so the ordering assertions
    // below cannot tell them apart — a 4% FMV difference on every moment that
    // carries two traits.
    const plain = buildMarketSnapshot(
      input({ momentId: "mult", truth: truth({ marketBackedLastSale: 100 }) }),
    )
    const both = buildMarketSnapshot(
      input({
        momentId: "mult",
        specialSerialTraits: ["#1 Serial", "Perfect Mint"],
        truth: truth({ marketBackedLastSale: 100 }),
      }),
    )
    expect((both.fmvMid as number) / (plain.fmvMid as number)).toBeCloseTo(1.35 * 1.18, 2)
  })

  it("an unrecognised trait flags the special method but moves the price by exactly 1x", () => {
    // ⚠ A real and easy-to-miss split: `hasSpecialSerialPremium` is
    // `traits.length > 0`, so ANY trait switches fmvMethod to "special serial
    // premium model" — but `applySerialPremium` only multiplies for the five
    // NAMED traits. So an unknown trait relabels the method while leaving the
    // number identical. That is the correct behaviour (an unpriced quirk must
    // not invent a premium), and it is asserted so that a future edit adding a
    // catch-all multiplier has to do so deliberately.
    const plain = buildMarketSnapshot(
      input({ momentId: "mult", truth: truth({ marketBackedLastSale: 100 }) }),
    )
    const unknown = buildMarketSnapshot(
      input({
        momentId: "mult",
        specialSerialTraits: ["Palindrome"],
        truth: truth({ marketBackedLastSale: 100 }),
      }),
    )
    expect(unknown.fmvMethod).toBe("special serial premium model")
    expect(unknown.fmvMid).toBe(plain.fmvMid)
  })

  it("stacks multiple trait multipliers", () => {
    const one = buildMarketSnapshot(
      input({
        momentId: "stack",
        specialSerialTraits: ["Perfect Mint"],
        truth: truth({ marketBackedLastSale: 100 }),
      }),
    )
    const many = buildMarketSnapshot(
      input({
        momentId: "stack",
        specialSerialTraits: ["Perfect Mint", "Jersey Match", "First Mint"],
        truth: truth({ marketBackedLastSale: 100 }),
      }),
    )
    expect(many.fmvMid as number).toBeGreaterThan(one.fmvMid as number)
  })
})

describe("buildMarketSnapshot — FMV range width tracks truth score", () => {
  it("higher observed-source count tightens the low/high band", () => {
    const thin = buildMarketSnapshot(
      input({ truth: truth({ marketBackedAsk: 100, marketBackedBestOffer: 300, observedSourceCount: 0 }) }),
    )
    const rich = buildMarketSnapshot(
      input({
        truth: truth({
          marketBackedAsk: 100,
          marketBackedBestOffer: 300,
          observedSourceCount: 3,
          probeStatus: "docs-probe-success",
        }),
      }),
    )
    expect(rich.truthScore).toBeGreaterThan(thin.truthScore)
    // width % = (high-low)/mid; a higher truthScore uses a smaller width multiplier.
    expect(rich.fmvRangeWidthPct as number).toBeLessThanOrEqual(thin.fmvRangeWidthPct as number)
    expect(snapWidthValid(rich)).toBe(true)
  })
})

function snapWidthValid(s: ReturnType<typeof buildMarketSnapshot>): boolean {
  if (s.fmvLow == null || s.fmvHigh == null || s.fmvMid == null) return false
  return s.fmvLow <= s.fmvMid && s.fmvMid <= s.fmvHigh
}

describe("buildMarketSnapshot — best-marketplace routing", () => {
  it("sell routing picks the higher offer", () => {
    const snap = buildMarketSnapshot(
      input({ truth: truth({ topShotBestOffer: 30, flowtyBestOffer: 50 }) }),
    )
    expect(snap.bestSellMarketplace).toBe("Flowty")
    expect(snap.marketEdgeSellLabel).toBe("Sell to Flowty demand")
  })

  it("equal offers tie", () => {
    const snap = buildMarketSnapshot(
      input({ truth: truth({ topShotBestOffer: 40, flowtyBestOffer: 40 }) }),
    )
    expect(snap.bestSellMarketplace).toBe("Tie")
  })

  it("no offers anywhere → Unknown / no sell edge", () => {
    const snap = buildMarketSnapshot(input({ truth: truth() }))
    expect(snap.bestSellMarketplace).toBe("Unknown")
    expect(snap.marketEdgeSellLabel).toBe("No sell edge")
  })

  it("buy routing prefers Top Shot when it is the only observed ask", () => {
    // FLOWTY_MARKETPLACE_ENABLED defaults false in test, so flowty asks are
    // ignored for buy routing regardless; a lone TopShot ask → Top Shot.
    const snap = buildMarketSnapshot(input({ truth: truth({ topShotAsk: 12 }) }))
    expect(snap.bestBuyMarketplace).toBe("Top Shot")
    expect(snap.marketEdgeBuyLabel).toBe("Buy on Top Shot")
  })

  it("no asks anywhere → Unknown buy edge", () => {
    const snap = buildMarketSnapshot(input({ truth: truth() }))
    expect(snap.bestBuyMarketplace).toBe("Unknown")
    expect(snap.marketEdgeBuyLabel).toBe("No buy edge")
  })
})

describe("buildMarketSnapshot — valuation scope & passthrough", () => {
  it("parallel → Parallel scope", () => {
    expect(buildMarketSnapshot(input({ parallel: "Hexwave" })).valuationScope).toBe("Parallel")
  })
  it("edition key only → Edition scope", () => {
    expect(buildMarketSnapshot(input({ parallel: null })).valuationScope).toBe("Edition")
  })
  it("no edition key → Modeled scope", () => {
    expect(buildMarketSnapshot(input({ editionKey: null, parallel: null })).valuationScope).toBe("Modeled")
  })
  it("passes through the flowscan recent-sales series and marketKey", () => {
    const snap = buildMarketSnapshot(
      input({ truth: truth({ marketKey: "K", flowscanRecentSales: [1, 2, 3], flowscanSaleCount7d: 2 }) }),
    )
    expect(snap.marketKey).toBe("K")
    expect(snap.flowscanRecentSales).toEqual([1, 2, 3])
    expect(snap.flowscanSaleCount7d).toBe(2)
  })
})

describe("buildMarketSnapshot — Deal status via special-serial premium", () => {
  it("a special serial escapes the ask cap, so a low ask below the premium FMV reads as a Deal", () => {
    // For a special serial the ask-capped FMV branches are skipped, FMV is the
    // premium-modeled value (uncapped), and applySerialPremium can push it ABOVE
    // the ask. That is the only path where effectiveAsk < fmvMid, i.e. the only
    // way discountPct (and the Deal/Watch discount statuses) can fire.
    const snap = buildMarketSnapshot(
      input({
        momentId: "deal-probe",
        specialSerialTraits: ["#1 Serial"],
        truth: truth({ marketBackedAsk: 10, marketBackedLastSale: 100 }),
      }),
    )
    expect(snap.fmvMethod).toBe("special serial premium model")
    expect(snap.fmvMid as number).toBeGreaterThan(10) // premium FMV clears the ask
    expect(snap.discountPct).not.toBeNull()
    expect(snap.discountPct as number).toBeGreaterThanOrEqual(12)
    expect(snap.marketStatus).toBe("Deal")
  })
})

describe("buildMarketSnapshot — truth label", () => {
  it("ask+sale with a high truth score → Observed+", () => {
    const snap = buildMarketSnapshot(
      input({
        truth: truth({
          marketBackedAsk: 100,
          marketBackedLastSale: 90,
          observedSourceCount: 3,
          probeStatus: "docs-probe-success",
        }),
      }),
    )
    expect(snap.anchorType).toBe("ask+sale")
    expect(snap.truthScore).toBeGreaterThanOrEqual(70)
    expect(snap.truthLabel).toBe("Observed+")
  })

  it("sale-only anchor → Observed", () => {
    const snap = buildMarketSnapshot(input({ truth: truth({ marketBackedLastSale: 88 }) }))
    expect(snap.anchorType).toBe("sale")
    expect(snap.truthLabel).toBe("Observed")
  })

  it("ask+sale with a thin truth score → Hybrid (not Observed+)", () => {
    const snap = buildMarketSnapshot(
      input({
        truth: truth({ marketBackedAsk: 100, marketBackedLastSale: 90, observedSourceCount: 0 }),
      }),
    )
    expect(snap.anchorType).toBe("ask+sale")
    expect(snap.truthScore).toBeLessThan(70)
    expect(snap.truthLabel).toBe("Hybrid")
  })
})

describe("buildMarketSnapshot — probe-status truth scoring", () => {
  it("a partial probe scores above a failed probe, holding everything else equal", () => {
    const mk = (probeStatus: UnifiedMarketTruth["probeStatus"]) =>
      buildMarketSnapshot(
        input({
          momentId: "probe-fixed", // fixed seed → same confidence contribution
          truth: truth({ marketBackedAsk: 100, marketBackedLastSale: 90, observedSourceCount: 1, probeStatus }),
        }),
      ).truthScore

    expect(mk("docs-probe-partial")).toBeGreaterThan(mk("docs-probe-failed"))
    // flowty-* variants share the same scoring arms.
    expect(mk("flowty-partial")).toBeGreaterThan(mk("flowty-failed"))
    // a failed probe scores below a clean success.
    expect(mk("docs-probe-failed")).toBeLessThan(mk("docs-probe-success"))
  })
})

describe("buildMarketSnapshot — serial premium (Last Mint)", () => {
  it("Last Mint applies its multiplier above the plain blended model", () => {
    const base = buildMarketSnapshot(
      input({ momentId: "lastmint", truth: truth({ marketBackedLastSale: 100 }) }),
    )
    const lastMint = buildMarketSnapshot(
      input({
        momentId: "lastmint",
        specialSerialTraits: ["Last Mint"],
        truth: truth({ marketBackedLastSale: 100 }),
      }),
    )
    expect(lastMint.fmvMethod).toBe("special serial premium model")
    expect(lastMint.fmvMid as number).toBeGreaterThan(base.fmvMid as number)
  })
})

describe("buildMarketSnapshot — liquidity & deal bands track their scores", () => {
  // Scores are seed- and input-dependent; rather than force one exact band, assert
  // the band ALWAYS matches its score's threshold across a spread of inputs. This
  // exercises the High/Medium/Low (and Strong/Medium/Weak) comparison arms with
  // whatever scores the varied inputs produce.
  const bandForLiquidity = (s: number) => (s >= 70 ? "High" : s >= 40 ? "Medium" : "Low")
  const bandForDeal = (s: number) => (s >= 60 ? "Strong" : s >= 30 ? "Medium" : "Weak")

  it("band classification is consistent with the numeric score for many inputs", () => {
    const variants: SnapshotInput[] = [
      input({ momentId: "b1" }),
      input({ momentId: "b2", truth: truth({ marketBackedAsk: 100, marketBackedBestOffer: 98, flowscanSaleCount30d: 9, flowscanSaleCount7d: 4 }) }),
      input({ momentId: "b3", truth: truth({ marketBackedAsk: 100, marketBackedBestOffer: 40 }) }),
      input({ momentId: "b4", truth: truth({ marketBackedAsk: 100, marketBackedBestOffer: 20 }) }),
      input({ momentId: "b5", specialSerialTraits: ["#1 Serial"], truth: truth({ marketBackedAsk: 5, marketBackedLastSale: 100 }) }),
      input({ momentId: "b6", truth: truth({ marketBackedLastSale: 60 }) }),
    ]
    for (const v of variants) {
      const snap = buildMarketSnapshot(v)
      expect(snap.liquidityBand).toBe(bandForLiquidity(snap.liquidityScore))
      expect(snap.dealBand).toBe(bandForDeal(snap.dealScore))
    }
  })
})

describe("buildMarketSnapshot — bounded scores & spread", () => {
  it("liquidity and deal scores stay within [0,100] and bands match thresholds", () => {
    const snap = buildMarketSnapshot(
      input({
        truth: truth({
          marketBackedAsk: 100,
          marketBackedBestOffer: 95, // tight 5% spread → strong liquidity add
          flowscanSaleCount30d: 10,
          flowscanSaleCount7d: 3,
          observedSourceCount: 2,
        }),
      }),
    )
    expect(snap.liquidityScore).toBeGreaterThanOrEqual(0)
    expect(snap.liquidityScore).toBeLessThanOrEqual(100)
    expect(snap.dealScore).toBeGreaterThanOrEqual(0)
    expect(snap.dealScore).toBeLessThanOrEqual(100)
    // spread% = (ask-offer)/ask = 5 → within the "High" contribution tier.
    expect(snap.spreadPct).toBe(5)
    if (snap.liquidityScore >= 70) expect(snap.liquidityBand).toBe("High")
  })
})
