import { describe, it, expect } from "vitest"
import {
  TIER_THRESHOLDS,
  tierFor,
  computeTierProgress,
  relativeTimeAgo,
  formatOddsAge,
  formatAmericanOdds,
  formatTipoff,
  validateRtrInputs,
  computeLivePickView,
  sortLockRoiRows,
  type LockRoiSortable,
} from "@/lib/rtr-client-compute"

// Pins the pure tier/progress/ROI/formatting logic lifted out of
// components/rtr/RTRClient.tsx (which is invisible to the coverage ratchet).
// A regression here mis-ranks the Lock ROI table, mis-computes the tier
// progress bar, or garbles the Tonight's Pick / odds labels.

describe("tierFor", () => {
  it("maps points to the highest cleared threshold", () => {
    expect(tierFor(0).name).toBe("Prospect")
    expect(tierFor(999).name).toBe("Prospect")
    expect(tierFor(1000).name).toBe("Starter")
    expect(tierFor(9999).name).toBe("Starter")
    expect(tierFor(10000).name).toBe("All-Star")
    expect(tierFor(40000).name).toBe("All-NBA")
    expect(tierFor(100000).name).toBe("MVP")
    expect(tierFor(200000).name).toBe("Legend")
    expect(tierFor(5_000_000).name).toBe("Legend")
  })

  it("floors negative points to the lowest tier", () => {
    expect(tierFor(-100).name).toBe("Prospect")
    expect(tierFor(-100)).toBe(TIER_THRESHOLDS[0])
  })
})

describe("computeTierProgress", () => {
  it("computes fractional progress toward the next tier", () => {
    // Starter spans 1000..10000; 5500 is halfway (span 9000).
    const p = computeTierProgress(5500)
    expect(p.currentTier.name).toBe("Starter")
    expect(p.nextTier?.name).toBe("All-Star")
    expect(p.lower).toBe(1000)
    expect(p.upper).toBe(10000)
    expect(p.progressPct).toBeCloseTo(50, 5)
  })

  it("reports 100% and no next tier at the max tier", () => {
    const p = computeTierProgress(250000)
    expect(p.currentTier.name).toBe("Legend")
    expect(p.nextTier).toBeNull()
    expect(p.upper).toBe(p.lower)
    expect(p.progressPct).toBe(100)
  })

  it("clamps progress to [0,100] and starts a tier at 0%", () => {
    expect(computeTierProgress(1000).progressPct).toBe(0)
    // Just under the next tier boundary rounds high but stays <= 100.
    const near = computeTierProgress(9999)
    expect(near.progressPct).toBeGreaterThan(99)
    expect(near.progressPct).toBeLessThanOrEqual(100)
  })
})

describe("relativeTimeAgo", () => {
  const now = Date.parse("2026-07-24T12:00:00.000Z")
  it("returns 'never' for null or unparseable input", () => {
    expect(relativeTimeAgo(null, now)).toBe("never")
    expect(relativeTimeAgo("not-a-date", now)).toBe("never")
  })
  it("bucketizes into just now / minutes / hours / days", () => {
    expect(relativeTimeAgo("2026-07-24T11:59:30.000Z", now)).toBe("just now")
    expect(relativeTimeAgo("2026-07-24T11:45:00.000Z", now)).toBe("15m ago")
    expect(relativeTimeAgo("2026-07-24T09:00:00.000Z", now)).toBe("3h ago")
    expect(relativeTimeAgo("2026-07-22T12:00:00.000Z", now)).toBe("2d ago")
  })
})

describe("formatOddsAge", () => {
  const now = Date.parse("2026-07-24T12:00:00.000Z")
  it("returns 'unknown' for unparseable input", () => {
    expect(formatOddsAge("nope", now)).toBe("unknown")
  })
  it("bucketizes just now / minutes / hours (no days bucket)", () => {
    expect(formatOddsAge("2026-07-24T11:59:30.000Z", now)).toBe("just now")
    expect(formatOddsAge("2026-07-24T11:30:00.000Z", now)).toBe("30m ago")
    expect(formatOddsAge("2026-07-23T12:00:00.000Z", now)).toBe("24h ago")
  })
})

describe("formatAmericanOdds", () => {
  it("prefixes positive odds with +, passes through negative, dashes 0/NaN", () => {
    expect(formatAmericanOdds(150)).toBe("+150")
    expect(formatAmericanOdds(-200)).toBe("-200")
    expect(formatAmericanOdds(0)).toBe("—")
    expect(formatAmericanOdds(NaN)).toBe("—")
    expect(formatAmericanOdds(Infinity)).toBe("—")
  })
})

describe("formatTipoff", () => {
  it("returns empty string for unparseable input", () => {
    expect(formatTipoff("garbage")).toBe("")
  })
  it("returns a non-empty formatted string for a valid ISO time", () => {
    const out = formatTipoff("2026-07-24T23:30:00.000Z")
    expect(typeof out).toBe("string")
    expect(out.length).toBeGreaterThan(0)
  })
})

describe("validateRtrInputs", () => {
  it("accepts two finite non-negative numbers", () => {
    expect(validateRtrInputs("1000", "50")).toEqual({ valid: true, points: 1000, balance: 50 })
    expect(validateRtrInputs("0", "0")).toEqual({ valid: true, points: 0, balance: 0 })
  })
  it("rejects negatives and non-numeric input", () => {
    expect(validateRtrInputs("-1", "5").valid).toBe(false)
    expect(validateRtrInputs("5", "-1").valid).toBe(false)
    expect(validateRtrInputs("abc", "5").valid).toBe(false)
    expect(validateRtrInputs("5", "xyz").valid).toBe(false)
  })

  it("treats an empty string as 0 (Number(\"\") === 0) — the component gates blanks in the UI, not here", () => {
    expect(validateRtrInputs("", "5")).toEqual({ valid: true, points: 0, balance: 5 })
  })
})

describe("computeLivePickView", () => {
  const base = {
    homeTeam: "Trail Blazers",
    awayTeam: "Lakers",
    homeML: -150,
    awayML: 130,
    impliedProbability: 0.615,
  }
  it("selects home side when recommendedSide is home_ml", () => {
    expect(computeLivePickView({ ...base, recommendedSide: "home_ml" })).toEqual({
      sideTeam: "Trail Blazers",
      opposingTeam: "Lakers",
      sideMl: -150,
      pct: 62,
    })
  })
  it("selects away side when recommendedSide is away_ml", () => {
    expect(computeLivePickView({ ...base, recommendedSide: "away_ml" })).toEqual({
      sideTeam: "Lakers",
      opposingTeam: "Trail Blazers",
      sideMl: 130,
      pct: 62,
    })
  })
})

describe("sortLockRoiRows", () => {
  const rows: (LockRoiSortable & { id: string })[] = [
    { id: "a", pointsPerDollar: 1.5, currentFmvUsd: 20, estimatedPlayoffPoints: 30, playerName: "Zeke", setName: null },
    { id: "b", pointsPerDollar: 3.0, currentFmvUsd: 10, estimatedPlayoffPoints: 30, playerName: "Ana", setName: "Base" },
    { id: "c", pointsPerDollar: 2.0, currentFmvUsd: 50, estimatedPlayoffPoints: 10, playerName: null, setName: "Rare" },
  ]

  it("sorts numeric fields ascending and descending", () => {
    expect(sortLockRoiRows(rows, "pointsPerDollar", "asc").map(r => r.id)).toEqual(["a", "c", "b"])
    expect(sortLockRoiRows(rows, "pointsPerDollar", "desc").map(r => r.id)).toEqual(["b", "c", "a"])
    expect(sortLockRoiRows(rows, "currentFmvUsd", "desc").map(r => r.id)).toEqual(["c", "a", "b"])
  })

  it("sorts string fields via localeCompare with null coerced to ''", () => {
    // asc: null ("") first, then Ana, then Zeke
    expect(sortLockRoiRows(rows, "playerName", "asc").map(r => r.id)).toEqual(["c", "b", "a"])
    expect(sortLockRoiRows(rows, "playerName", "desc").map(r => r.id)).toEqual(["a", "b", "c"])
  })

  it("does not mutate the input array", () => {
    const before = rows.map(r => r.id)
    sortLockRoiRows(rows, "pointsPerDollar", "desc")
    expect(rows.map(r => r.id)).toEqual(before)
  })

  it("handles an empty array", () => {
    expect(sortLockRoiRows([], "pointsPerDollar", "asc")).toEqual([])
  })
})
