// The shared liveness pattern is itself pinned, because a guard's pattern is a
// claim and this one was WRONG in a way that read as correct.
//
// The "actively" case is the one that matters: the pre-2026-09-06 pattern used
// `\bactive\b` and a positive control fed it "being ACTIVELY swept" — which
// PASSED. Every inflected form below is here so the hole cannot silently
// reopen, and the negatives are here so nobody widens the stems into words that
// honest historical copy needs.

import { describe, it, expect } from "vitest"
import { MARKET_LIVENESS_CLAIM, claimsLiveMarket } from "./market-liveness"

const CLAIMS_LIVE = [
  "Live deals below FMV",
  "LIVE",
  "Real-time deals below FMV",
  "real time pricing",
  "realtime feed",
  "FMV + active listing prices",
  "Editions whose floor is being actively swept", // ← the case that broke it
  "market activity this week",
  "the current floor",
  "currently trading",   // caught by "currently", not by "trading"
  "active trading",      // caught by "active"
  "buy it now",
  "today's sales",
  "the daily market pulse",
  "an ongoing auction",
]

const DOES_NOT_CLAIM_LIVE = [
  "FLOW MARKET CLOSED 13 MAY 2026 — EVERY PRICE BELOW IS A FINAL ONE",
  "Your moments at their closing values",
  "The last discounts before the market closed",
  "Edition lookup + closing leaderboards",
  "Completion + bottleneck finder",
  "Portfolio breakdown + clarity",
  "SALES HISTORY — EVERY RECORDED SALE, THROUGH THE LAST ONE",
  "Expected value against final prices",
  // Negative controls on the STEMS: these must NOT be swallowed, or honest
  // historical copy becomes unwritable and the guard gets loosened later.
  "priced in a different currency",
  "a traditional pack break",
  "delivery of the moment",
  "he knows the set well",
  // ⚠ THE SIX SENTENCES THAT DECIDED THE "trading" QUESTION. All past-tense or
  // negated, all honest, all shipped. A ban that reds these is a ban someone
  // deletes; see the header of market-liveness.ts.
  "What your moments were worth when trading stopped: last-observed FMV",
  "every value shown is the last observed before trading stopped",
  "the last discounts to FMV observed before trading stopped, per edition",
  "Historical analysis, not a buy recommendation — the packs are no longer trading.",
  "the leaderboards rank what happened, not what is trading",
  "FLOW MARKET CLOSED 13 MAY 2026 — FINAL OBSERVED DISCOUNTS, NOTHING IS TRADING",
]

describe("MARKET_LIVENESS_CLAIM", () => {
  it("has cases on both sides (population control)", () => {
    expect(CLAIMS_LIVE.length).toBeGreaterThan(10)
    expect(DOES_NOT_CLAIM_LIVE.length).toBeGreaterThan(8)
  })

  it("the documented gap is REAL — a bare gerund claim is not caught", () => {
    // Pinned as a KNOWN LIMIT, not an oversight. If this ever starts passing,
    // someone re-added the blunt "trad" stem and the six sentences above are
    // about to red; read the header before "fixing" this.
    expect(claimsLiveMarket("Trading below FMV")).toBe(false)
  })

  it("catches every present-tense trading claim, inflections included", () => {
    for (const s of CLAIMS_LIVE) expect(claimsLiveMarket(s), s).toBe(true)
  })

  it("leaves honest historical copy alone", () => {
    for (const s of DOES_NOT_CLAIM_LIVE) expect(claimsLiveMarket(s), s).toBe(false)
  })

  it("is not sticky — the exported regex has no /g flag", () => {
    // A /g regex carries lastIndex across .test() calls, so a shared module-level
    // one would return alternating true/false for the SAME input. Every guard
    // below reuses this object across a loop, so this is load-bearing.
    expect(MARKET_LIVENESS_CLAIM.global).toBe(false)
    expect(claimsLiveMarket("LIVE")).toBe(true)
    expect(claimsLiveMarket("LIVE")).toBe(true)
  })
})
