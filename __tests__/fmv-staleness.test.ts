import { describe, it, expect } from "vitest"
import { applyFmvStalenessPenalty } from "@/lib/sniper/fmv-staleness"

// Pins the sniper's display-time "don't surface fake bargains" haircut. An
// inflated FMV from a lone weeks-old sale would otherwise show a huge fake
// discount; these rules haircut / cap it. Regression here re-surfaces the
// fake bargains the guard exists to suppress.

describe("applyFmvStalenessPenalty", () => {
  it("is a no-op for a fresh, well-traded edition", () => {
    // 5 sales in 30d, sold 2 days ago → no penalty
    expect(applyFmvStalenessPenalty(100, 80, "HIGH", 2, 5)).toBe(100)
  })

  it("applies the 0.7 haircut when >14 days stale AND <=1 sale/30d", () => {
    expect(applyFmvStalenessPenalty(100, 80, "MEDIUM", 20, 1)).toBeCloseTo(70, 6)
    expect(applyFmvStalenessPenalty(100, 80, "MEDIUM", 20, 0)).toBeCloseTo(70, 6)
  })

  it("does NOT haircut when stale but still trading (>1 sale/30d)", () => {
    expect(applyFmvStalenessPenalty(100, 80, "MEDIUM", 20, 3)).toBe(100)
  })

  it("does NOT haircut when recent even with a single sale", () => {
    expect(applyFmvStalenessPenalty(100, 80, "MEDIUM", 10, 1)).toBe(100)
  })

  it("caps LOW-confidence FMV at askPrice when >30 days stale (0% discount)", () => {
    // LOW + 40 days: first the 0.7 haircut (100→70), then cap at ask 80 → 70
    // (already below ask, so cap leaves it). Use a case where the cap bites:
    expect(applyFmvStalenessPenalty(200, 80, "LOW", 40, 0)).toBe(80) // 200*0.7=140, capped to 80
  })

  it("cap uses the lower of penalized-FMV and ask", () => {
    // LOW, 40 days, but plenty of sales so no 0.7 haircut; FMV 90 capped to ask 80
    expect(applyFmvStalenessPenalty(90, 80, "low", 40, 9)).toBe(80)
  })

  it("returns non-positive FMV untouched", () => {
    expect(applyFmvStalenessPenalty(0, 80, "LOW", 99, 0)).toBe(0)
    expect(applyFmvStalenessPenalty(-5, 80, "LOW", 99, 0)).toBe(-5)
  })

  it("treats null daysSinceSale / salesCount as 0 (recent, no sales → no stale haircut)", () => {
    // days null→0 (not >14) so no 0.7; not >30 so no cap → unchanged
    expect(applyFmvStalenessPenalty(100, 80, "LOW", null, null)).toBe(100)
  })
})
