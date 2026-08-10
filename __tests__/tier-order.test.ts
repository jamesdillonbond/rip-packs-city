import { describe, it, expect } from "vitest"
import {
  CANONICAL_TIER_RANKS,
  CANONICAL_TIERS,
  normalizeTier,
  tierRank,
  titleCaseTier,
  tierLadder,
} from "@/lib/tier-order"
import { TIER_ORDER as FMV_TIER_ORDER } from "@/lib/analytics-fmv-dashboard-compute"
import { TIER_ORDER as SETS_TIER_ORDER } from "@/lib/analytics-sets-dashboard-compute"
import { TIER_ORDER as FASTBREAK_TIER_ORDER } from "@/lib/fast-break-client-compute"
import { TIER_ORDER as TROPHY_TIER_ORDER } from "@/lib/trophy-picker-format"

// deep-audit D23: four separate TIER_ORDER arrays had drifted into three
// casings, both sort directions, and UNCOMMON in exactly one of the four.
// The consequence was not cosmetic — the FMV dashboard's TitleCase list never
// matched the RPC's UPPERCASE enum values, so every row bucketed to "Other".
//
// The guard is deliberately NOT "all four arrays must be equal": they legitimately
// differ in scope (Fast Break is Top Shot only), casing (display vs enum) and
// direction (common-first bars vs rarest-first progress). What must hold is that
// each is a consistent PROJECTION of one ladder.

describe("canonical tier ladder", () => {
  it("covers every tier_type enum value the DB can store", () => {
    // Verified live 2026-08-09: Top Shot uses COMMON/FANDOM/RARE/LEGENDARY/
    // ULTIMATE; All Day + Golazos add UNCOMMON (630 + 215 editions); UFC Strike
    // uses CONTENDER/CHALLENGER/CHAMPION (460/55/1).
    for (const t of [
      "COMMON", "FANDOM", "UNCOMMON", "RARE", "LEGENDARY", "ULTIMATE",
      "CONTENDER", "CHALLENGER", "CHAMPION",
    ]) {
      expect(CANONICAL_TIERS).toContain(t)
    }
  })

  it("normalizes any casing and rejects a non-tier", () => {
    expect(normalizeTier("common")).toBe("COMMON")
    expect(normalizeTier("Common")).toBe("COMMON")
    expect(normalizeTier(" LEGENDARY ")).toBe("LEGENDARY")
    // Must be null, not a fabricated tier — the RPC emits "UNKNOWN" for real.
    expect(normalizeTier("UNKNOWN")).toBeNull()
    expect(normalizeTier(null)).toBeNull()
    expect(normalizeTier("")).toBeNull()
  })

  it("is not fooled by an Object.prototype key", () => {
    expect(normalizeTier("constructor")).toBeNull()
    expect(normalizeTier("toString")).toBeNull()
    expect(tierRank("hasOwnProperty")).toBeNull()
  })

  it("ranks rarity ascending", () => {
    expect(tierRank("COMMON")!).toBeLessThan(tierRank("RARE")!)
    expect(tierRank("RARE")!).toBeLessThan(tierRank("LEGENDARY")!)
    expect(tierRank("LEGENDARY")!).toBeLessThan(tierRank("ULTIMATE")!)
    expect(tierRank("CONTENDER")!).toBeLessThan(tierRank("CHAMPION")!)
  })

  it("gives FANDOM and UNCOMMON the same rank (collection-disjoint)", () => {
    // Top Shot has FANDOM and no UNCOMMON; All Day / Golazos the reverse. They
    // never share a breakdown, so any total order between them would be invented.
    expect(tierRank("FANDOM")).toBe(tierRank("UNCOMMON"))
  })

  it("asc and desc are exact inverses", () => {
    expect(tierLadder("desc")).toEqual([...tierLadder("asc")].reverse())
  })

  it("emits the requested casing", () => {
    expect(tierLadder("asc", { casing: "title" })[0]).toBe("Common")
    expect(tierLadder("asc", { casing: "lower" })[0]).toBe("common")
    expect(tierLadder("asc")[0]).toBe("COMMON")
  })

  it("can be scoped to one collection's tiers", () => {
    const ts = tierLadder("desc", { only: ["COMMON", "FANDOM", "RARE", "LEGENDARY", "ULTIMATE"] })
    expect(ts).toEqual(["ULTIMATE", "LEGENDARY", "RARE", "FANDOM", "COMMON"])
  })

  it("titleCaseTier round-trips the enum spelling", () => {
    expect(titleCaseTier("ULTIMATE")).toBe("Ultimate")
    expect(titleCaseTier("CHALLENGER")).toBe("Challenger")
  })
})

describe("the four TIER_ORDER copies stay consistent with the ladder", () => {
  const COPIES: Array<{ name: string; order: readonly string[]; direction: "asc" | "desc" }> = [
    { name: "analytics-fmv-dashboard-compute", order: FMV_TIER_ORDER, direction: "asc" },
    { name: "analytics-sets-dashboard-compute", order: SETS_TIER_ORDER, direction: "asc" },
    { name: "fast-break-client-compute", order: FASTBREAK_TIER_ORDER, direction: "desc" },
    { name: "trophy-picker-format", order: TROPHY_TIER_ORDER, direction: "desc" },
  ]

  it.each(COPIES)("$name contains only canonical tier names", ({ order }) => {
    // Catches a typo or an invented tier regardless of casing.
    for (const t of order) expect(normalizeTier(t), `${t} is not a canonical tier`).not.toBeNull()
  })

  it.each(COPIES)("$name is ordered consistently with canonical rank", ({ order, direction }) => {
    const ranks = order.map((t) => tierRank(t)!)
    for (let i = 1; i < ranks.length; i++) {
      // Equal ranks are allowed (the FANDOM/UNCOMMON disjoint pair).
      if (direction === "asc") expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1])
      else expect(ranks[i]).toBeLessThanOrEqual(ranks[i - 1])
    }
  })

  it.each(COPIES)("$name uses one internally-consistent casing", ({ order }) => {
    const casings = new Set(
      order.map((t) => (t === t.toUpperCase() ? "upper" : t === t.toLowerCase() ? "lower" : "title")),
    )
    expect([...casings].length).toBe(1)
  })

  it("the two dashboards cover every tier; the scoped copies may not", () => {
    // The dashboards render ALL collections, so a missing tier there silently
    // dumps a whole collection into "Other" — which is exactly what happened to
    // Uncommon and the UFC ladder. Fast Break (Top Shot only) and the trophy
    // picker are legitimately narrower.
    expect(FMV_TIER_ORDER.length).toBe(CANONICAL_TIERS.length)
    for (const t of FASTBREAK_TIER_ORDER) expect(CANONICAL_TIERS).toContain(normalizeTier(t))
  })
})
