import { describe, it, expect } from "vitest"
import { physicalTotal, type PhysicalHolding, type CachedRange } from "@/lib/physical/portfolio"

// Physical totals are ranges, unpriced holdings are never $0, and a cost basis
// is only reported when every priced holding has one.

const h = (id: string, cardId: string, grade: string, qty = 1, cost: number | null = 10): PhysicalHolding => ({
  id, cardId, grader: grade === "raw" ? "raw" : "psa", grade, quantity: qty, costBasisUsd: cost,
})
const r = (cardId: string, grade: string, low: number, point: number, high: number): CachedRange => ({
  cardId, grader: grade === "raw" ? "raw" : "psa", grade, lowUsd: low, pointUsd: point, highUsd: high, source: "HobbyCardIndex",
})

describe("physicalTotal", () => {
  it("sums ranges by quantity", () => {
    const t = physicalTotal([h("a", "c1", "10"), h("b", "c2", "raw", 3)], [r("c1", "10", 90, 100, 110), r("c2", "raw", 1, 2, 3)])
    expect([t.low, t.point, t.high]).toEqual([93, 106, 119])
    expect(t.sources).toEqual(["HobbyCardIndex"])
    expect(t.costBasis).toBe(20)
  })

  it("counts a holding with no range as unpriced, not zero", () => {
    const t = physicalTotal([h("a", "c1", "10"), h("b", "c9", "10")], [r("c1", "10", 90, 100, 110)])
    expect(t.pricedCount).toBe(1)
    expect(t.unpricedIds).toEqual(["b"])
    expect(t.point).toBe(100)
  })

  it("never prices a PSA 10 from a PSA 9 range", () => {
    const t = physicalTotal([h("a", "c1", "10")], [r("c1", "9", 40, 50, 60)])
    expect(t.pricedCount).toBe(0)
    expect(t.point).toBe(0)
    expect(t.unpricedCount).toBe(1)
  })

  it("withholds cost basis when any priced holding lacks one", () => {
    const t = physicalTotal([h("a", "c1", "10", 1, null), h("b", "c1", "10")], [r("c1", "10", 90, 100, 110)])
    expect(t.costBasis).toBeNull()
  })
})
