import { describe, it, expect } from "vitest"
import {
  americanOddsToImpliedProbability,
  devigImpliedProbabilities,
  rankNightlyPicks,
  recommendBalanceAllocation,
  type Pick,
} from "@/lib/rtr-picks"

describe("americanOddsToImpliedProbability", () => {
  it("converts -150 to 0.6", () => {
    expect(americanOddsToImpliedProbability(-150)).toBeCloseTo(0.6, 4)
  })

  it("converts +180 to ~0.357", () => {
    expect(americanOddsToImpliedProbability(180)).toBeCloseTo(100 / 280, 4)
  })

  it("converts -110 to ~0.524", () => {
    expect(americanOddsToImpliedProbability(-110)).toBeCloseTo(110 / 210, 4)
  })

  it("returns 0 for invalid odds", () => {
    expect(americanOddsToImpliedProbability(0)).toBe(0)
    expect(americanOddsToImpliedProbability(NaN)).toBe(0)
  })
})

describe("devigImpliedProbabilities", () => {
  it("returns 0.5 / 0.5 for a -110 / -110 pick'em", () => {
    const { homeProb, awayProb } = devigImpliedProbabilities(-110, -110)
    expect(homeProb).toBeCloseTo(0.5, 4)
    expect(awayProb).toBeCloseTo(0.5, 4)
  })

  it("normalizes so probabilities sum to 1", () => {
    const { homeProb, awayProb } = devigImpliedProbabilities(-200, +170)
    expect(homeProb + awayProb).toBeCloseTo(1, 6)
  })

  it("preserves the favorite", () => {
    const { homeProb, awayProb } = devigImpliedProbabilities(-300, +250)
    expect(homeProb).toBeGreaterThan(awayProb)
  })
})

describe("rankNightlyPicks", () => {
  it("orders games by max(homeProb, awayProb) descending", () => {
    const picks: Pick[] = [
      { gameId: "g1", homeTeam: "POR", awayTeam: "LAL", homeML: -110, awayML: -110 },
      { gameId: "g2", homeTeam: "BOS", awayTeam: "DAL", homeML: -400, awayML: +320 },
      { gameId: "g3", homeTeam: "MEM", awayTeam: "OKC", homeML: -150, awayML: +130 },
    ]
    const ranked = rankNightlyPicks(picks)
    expect(ranked[0].gameId).toBe("g2")
    expect(ranked[2].gameId).toBe("g1")
  })

  it("recommends the favorite side and labels probability in rationale", () => {
    const picks: Pick[] = [
      { gameId: "g1", homeTeam: "POR", awayTeam: "LAL", homeML: -250, awayML: +210 },
    ]
    const [r] = rankNightlyPicks(picks)
    expect(r.recommendedSide).toBe("home_ml")
    expect(r.rationale).toMatch(/POR/)
    expect(r.rationale).toMatch(/%/)
  })

  it("recommends away when away is the favorite", () => {
    const picks: Pick[] = [
      { gameId: "g1", homeTeam: "DET", awayTeam: "BOS", homeML: +280, awayML: -340 },
    ]
    const [r] = rankNightlyPicks(picks)
    expect(r.recommendedSide).toBe("away_ml")
  })
})

describe("recommendBalanceAllocation", () => {
  it("allocates the full balance to the top-ranked pick", () => {
    const ranked = rankNightlyPicks([
      { gameId: "g1", homeTeam: "POR", awayTeam: "LAL", homeML: -110, awayML: -110 },
      { gameId: "g2", homeTeam: "BOS", awayTeam: "DAL", homeML: -400, awayML: +320 },
    ])
    const out = recommendBalanceAllocation(5000, ranked)
    expect(out).toEqual([{ gameId: "g2", recommendedAmount: 5000 }])
  })

  it("returns empty array when balance is non-positive", () => {
    const ranked = rankNightlyPicks([
      { gameId: "g1", homeTeam: "A", awayTeam: "B", homeML: -200, awayML: +170 },
    ])
    expect(recommendBalanceAllocation(0, ranked)).toEqual([])
  })

  it("returns empty array when no picks supplied", () => {
    expect(recommendBalanceAllocation(1000, [])).toEqual([])
  })
})
