import { describe, it, expect } from "vitest"
import { fmtUsd, liveStat, type HubInsightStats } from "@/lib/insights-hub-format"

// Pure helpers behind the public /insights hub cards. liveStat is the per-card
// headline sentence; a wrong branch misstates a number on the highest-traffic
// public surface, a crash drops the card's stat entirely.

const S: HubInsightStats = {
  squeezeEditions: 1234,
  setSqueezeSets: 42,
  pinnacleEditions: 777,
  packZeroPct: 61,
  packRips60d: 9800,
  rookieGmv30d: 2_500_000,
  rookieCount: 18,
  firstMintAvg: 1.7,
  firstMintMax: 9,
  crossCohort: 305,
}

describe("insights-hub-format · fmtUsd", () => {
  it("bands millions / thousands / units and guards non-finite", () => {
    expect(fmtUsd(2_500_000)).toBe("$2.5M")
    expect(fmtUsd(9_800)).toBe("$10K") // rounds to nearest K
    expect(fmtUsd(1_000)).toBe("$1K")
    expect(fmtUsd(999)).toBe("$999")
    expect(fmtUsd(0)).toBe("$0")
    expect(fmtUsd(NaN)).toBe("$0")
    expect(fmtUsd(Infinity)).toBe("$0")
  })
})

describe("insights-hub-format · liveStat", () => {
  it("renders each known card's live sentence with thousands separators", () => {
    expect(liveStat("/insights/squeeze", S)).toBe("1,234 editions ≥50% squeezed")
    expect(liveStat("/insights/pack-reality", S)).toBe("61% of rips pull $0 · 9,800 rips/60d")
    expect(liveStat("/insights/rookies", S)).toBe("$2.5M GMV/30d · 18 rookies")
    expect(liveStat("/insights/first-mint", S)).toBe("avg 1.7× · max 9×")
    expect(liveStat("/insights/cross-collection", S)).toBe("305 wallets hold 3+ collections")
    expect(liveStat("/insights/set-squeeze", S)).toBe("42 sets ranked")
    expect(liveStat("/insights/pinnacle-scarcity", S)).toBe("777 editions ranked")
  })

  it("returns null for a card with no live stat (and for a null slug)", () => {
    expect(liveStat("/insights/account-value", S)).toBeNull()
    expect(liveStat("/insights/unknown-board", S)).toBeNull()
    expect(liveStat(null, S)).toBeNull()
  })
})
