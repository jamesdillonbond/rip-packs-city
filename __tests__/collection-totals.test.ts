import { describe, it, expect } from "vitest"
import { computeCollectionTotals } from "@/lib/collection/totals"
import type { MomentRow } from "@/lib/collection/types"

function row(over: Partial<MomentRow> = {}): MomentRow {
  return {
    momentId: "m",
    playerName: "P",
    setName: "S",
    fmv: null,
    bestOffer: null,
    bestAsk: null,
    isLocked: false,
    marketConfidence: "none",
    badgeInfo: null as any,
    ...over,
  } as MomentRow
}

describe("computeCollectionTotals", () => {
  it("returns an all-zero shape for an empty list", () => {
    const t = computeCollectionTotals([])
    expect(t.totalFmv).toBe(0)
    expect(t.totalCount).toBe(0)
    expect(t.spreadGap).toBe(0)
    expect(t.confNone).toBe(0)
  })

  it("sums fmv and bestOffer independently and derives spreadGap", () => {
    const t = computeCollectionTotals([
      row({ fmv: 10, bestOffer: 6 }),
      row({ fmv: 5, bestOffer: null }),
    ])
    expect(t.totalFmv).toBe(15)
    expect(t.totalBestOffer).toBe(6)
    expect(t.spreadGap).toBe(9) // 15 - 6
    expect(t.totalCount).toBe(2)
  })

  it("splits value by lock state using fmv → offer → bestAsk → 0 precedence", () => {
    const t = computeCollectionTotals([
      row({ fmv: 20, isLocked: true }),               // locked, value 20 from fmv
      row({ fmv: null, bestOffer: 7, isLocked: false }), // unlocked, value 7 from offer
      row({ fmv: null, bestOffer: null, bestAsk: 3, isLocked: false }), // value 3 from ask
      row({ fmv: null, bestOffer: null, bestAsk: null, isLocked: false }), // value 0
    ])
    expect(t.lockedFmv).toBe(20)
    expect(t.lockedCount).toBe(1)
    expect(t.unlockedFmv).toBe(10) // 7 + 3 + 0
    expect(t.unlockedCount).toBe(3)
  })

  it("buckets rows by market confidence with unknown → confNone", () => {
    const t = computeCollectionTotals([
      row({ marketConfidence: "high" }),
      row({ marketConfidence: "high" }),
      row({ marketConfidence: "medium" }),
      row({ marketConfidence: "low" }),
      row({ marketConfidence: "none" }),
      row({ marketConfidence: undefined as any }),
    ])
    expect(t.confHigh).toBe(2)
    expect(t.confMedium).toBe(1)
    expect(t.confLow).toBe(1)
    expect(t.confNone).toBe(2) // explicit "none" + undefined both fall through
  })

  it("counts a badge only when badge_score is truthy", () => {
    const t = computeCollectionTotals([
      row({ badgeInfo: { badge_score: 5 } as any }),
      row({ badgeInfo: { badge_score: 0 } as any }),
      row({ badgeInfo: null as any }),
    ])
    expect(t.badgeCount).toBe(1)
  })
})
