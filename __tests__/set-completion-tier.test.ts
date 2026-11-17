import { describe, it, expect } from "vitest"
import {
  classifySetTier,
  ALMOST_THERE_MAX_MISSING,
  PROGRESS_ALMOST_THERE_PCT,
} from "@/lib/set-completion-tier"

// lib/set-completion-tier.ts replaced FIVE duplicated ladders with FOUR
// different "almost there" thresholds (1|2, <=3 x3, and >=80%). These pin the
// unified contract so the surfaces cannot drift apart again.

describe("classifySetTier", () => {
  it("is complete at or above 100%", () => {
    expect(classifySetTier({ completionPct: 100, missingCount: 0 })).toBe("complete")
    expect(classifySetTier({ completionPct: 101, missingCount: 0 })).toBe("complete")
  })

  it("does NOT call an empty / zero-edition set complete", () => {
    // 0 missing but 0% done is an unindexed or empty set, not a finished one.
    expect(classifySetTier({ completionPct: 0, missingCount: 0 })).toBe("incomplete")
  })

  it("uses ONE almost-there threshold across every caller", () => {
    expect(ALMOST_THERE_MAX_MISSING).toBe(3)
    for (const missingCount of [1, 2, 3]) {
      expect(classifySetTier({ completionPct: 50, missingCount, estimatedCost: 42 })).toBe("almost_there")
    }
    // One past the line is a shopping list, not a near-miss.
    expect(classifySetTier({ completionPct: 50, missingCount: 4, estimatedCost: 42 })).toBe("completable")
  })

  it("never calls ZERO progress almost_there, even inside the missing-count window", () => {
    // Owning 0 of 3 satisfies missingCount <= 3; promoting it would tell a user
    // who owns nothing that they are nearly done. allday/ufc-set-progress both
    // guarded this before the unification and must not regress.
    expect(classifySetTier({ completionPct: 0, missingCount: 3, estimatedCost: 42 })).toBe("incomplete")
    expect(classifySetTier({ completionPct: 0, missingCount: 1, estimatedCost: 42, allPriced: true })).toBe("incomplete")
    // The first sliver of progress re-enters the normal ladder.
    expect(classifySetTier({ completionPct: 1, missingCount: 3, estimatedCost: 42 })).toBe("almost_there")
  })

  it("requires a real price signal before promising almost_there", () => {
    expect(classifySetTier({ completionPct: 90, missingCount: 1, estimatedCost: 0 })).toBe("unpriced")
    expect(classifySetTier({ completionPct: 90, missingCount: 1, estimatedCost: null })).toBe("unpriced")
  })

  it("treats a partially-priced set as un-actionable via allPriced", () => {
    // A positive cost total that does not cover every piece understates the
    // bill, so allPriced wins when supplied.
    expect(
      classifySetTier({ completionPct: 90, missingCount: 2, estimatedCost: 10, allPriced: false })
    ).toBe("completable")
    expect(
      classifySetTier({ completionPct: 90, missingCount: 2, estimatedCost: 10, allPriced: true })
    ).toBe("almost_there")
  })

  it("reports unpriced when ask enrichment never ran, regardless of cost", () => {
    expect(
      classifySetTier({ completionPct: 50, missingCount: 2, estimatedCost: 99, asksEnriched: false })
    ).toBe("unpriced")
  })

  it("surfaces a bottleneck only past the almost-there window", () => {
    expect(
      classifySetTier({ completionPct: 50, missingCount: 9, estimatedCost: 99, hasBottleneck: true })
    ).toBe("bottleneck")
    // Proximity wins over a bottleneck inside the window.
    expect(
      classifySetTier({ completionPct: 50, missingCount: 2, estimatedCost: 99, hasBottleneck: true })
    ).toBe("almost_there")
  })

  describe("progress-only ladder (callers with no pricing pipeline, e.g. /api/sets-db)", () => {
    it("uses the percentage threshold and never claims a price it lacks", () => {
      expect(PROGRESS_ALMOST_THERE_PCT).toBe(80)
      const p = (completionPct: number) =>
        classifySetTier({ completionPct, missingCount: 8, pricingAvailable: false })
      expect(p(85)).toBe("almost_there")
      expect(p(80)).toBe("almost_there")
      expect(p(79)).toBe("incomplete")
      expect(p(1)).toBe("incomplete")
      expect(p(0)).toBe("unpriced")
    })

    it("still reports 100% as complete", () => {
      expect(classifySetTier({ completionPct: 100, missingCount: 0, pricingAvailable: false })).toBe("complete")
    })
  })
})
