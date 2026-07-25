import { describe, it, expect } from "vitest"
import {
  TIER_TOKEN,
  TIER_ORDER,
  tierToken,
  thumbnailFor,
  initialsFor,
  applyOptimisticUses,
  groupUsesByTier,
  applyUseBumps,
  type Tier,
  type UseRowLike,
} from "@/lib/fast-break-client-compute"

// Pins the pure lineup/eligibility/tier logic lifted out of
// components/fast-break/FastBreakClient.tsx (which is invisible to the coverage
// ratchet). A regression here mis-groups the Run Progress widget, mis-applies
// optimistic use counts, or breaks the moment thumbnail / avatar fallbacks.

describe("tierToken", () => {
  it("returns the matching token for each known tier", () => {
    ;(Object.keys(TIER_TOKEN) as Tier[]).forEach(t => {
      expect(tierToken(t)).toBe(TIER_TOKEN[t])
    })
  })
  it("falls back to COMMON for an unexpected tier", () => {
    expect(tierToken("MYTHIC" as Tier)).toBe(TIER_TOKEN.COMMON)
  })
})

describe("thumbnailFor", () => {
  it("returns null for null/undefined/empty", () => {
    expect(thumbnailFor(null)).toBeNull()
    expect(thumbnailFor(undefined)).toBeNull()
    expect(thumbnailFor("")).toBeNull()
  })
  it("builds the assets CDN url for a moment id", () => {
    expect(thumbnailFor("abc123")).toBe(
      "https://assets.nbatopshot.com/media/abc123/image?width=180",
    )
  })
})

describe("initialsFor", () => {
  it("returns ?? for null/undefined/blank", () => {
    expect(initialsFor(null)).toBe("??")
    expect(initialsFor(undefined)).toBe("??")
    expect(initialsFor("   ")).toBe("??")
  })
  it("uses first two chars for a single-word name", () => {
    expect(initialsFor("Giannis")).toBe("GI")
    expect(initialsFor("Ai")).toBe("AI")
  })
  it("uses first+last initial for multi-word names, collapsing whitespace", () => {
    expect(initialsFor("Damian Lillard")).toBe("DL")
    expect(initialsFor("Shai  Gilgeous-Alexander")).toBe("SG")
    expect(initialsFor("  Luka   Doncic  ")).toBe("LD")
  })
})

describe("applyOptimisticUses", () => {
  const base: (UseRowLike & { fullName: string })[] = [
    { nbaPlayerId: "1", fullName: "A", highestTierOwned: "RARE", totalAllowed: 3, timesUsed: 1, remainingUses: 2 },
    { nbaPlayerId: "2", fullName: "B", highestTierOwned: "COMMON", totalAllowed: 2, timesUsed: 0, remainingUses: 2 },
  ]

  it("returns the base array unchanged when there are no pending bumps", () => {
    const out = applyOptimisticUses(base, {})
    expect(out).toBe(base)
  })

  it("bumps timesUsed and recomputes remainingUses", () => {
    const out = applyOptimisticUses(base, { "1": 1 })
    expect(out).not.toBe(base)
    expect(out[0]).toMatchObject({ timesUsed: 2, remainingUses: 1, fullName: "A" })
    // untouched row still bumps through the map (bump 0)
    expect(out[1]).toMatchObject({ timesUsed: 0, remainingUses: 2 })
  })

  it("clamps timesUsed to [0, totalAllowed]", () => {
    const over = applyOptimisticUses(base, { "1": 10 })
    expect(over[0]).toMatchObject({ timesUsed: 3, remainingUses: 0 })
    const under = applyOptimisticUses(base, { "2": -5 })
    expect(under[1]).toMatchObject({ timesUsed: 0, remainingUses: 2 })
  })
})

describe("groupUsesByTier", () => {
  type Row = { nbaPlayerId: string; highestTierOwned: Tier }
  const rows: Row[] = [
    { nbaPlayerId: "1", highestTierOwned: "COMMON" },
    { nbaPlayerId: "2", highestTierOwned: "ULTIMATE" },
    { nbaPlayerId: "3", highestTierOwned: "COMMON" },
    { nbaPlayerId: "4", highestTierOwned: "RARE" },
  ]

  it("groups by tier in TIER_ORDER and drops empty tiers", () => {
    const grouped = groupUsesByTier(rows)
    expect(grouped.map(g => g.tier)).toEqual(["ULTIMATE", "RARE", "COMMON"])
    expect(grouped.find(g => g.tier === "COMMON")?.rows.map(r => r.nbaPlayerId)).toEqual(["1", "3"])
    // FANDOM and LEGENDARY are absent -> dropped
    expect(grouped.some(g => g.tier === "FANDOM")).toBe(false)
    expect(grouped.some(g => g.tier === "LEGENDARY")).toBe(false)
  })

  it("returns an empty array for no rows", () => {
    expect(groupUsesByTier([])).toEqual([])
  })

  it("orders groups per TIER_ORDER (rarest first)", () => {
    expect(TIER_ORDER).toEqual(["ULTIMATE", "LEGENDARY", "RARE", "FANDOM", "COMMON"])
  })
})

describe("applyUseBumps", () => {
  it("adds +1 per added and -1 per removed, floored at 0, from an empty base", () => {
    expect(applyUseBumps({}, ["x", "x", "y"], ["z"])).toEqual({ x: 2, y: 1, z: 0 })
  })
  it("merges onto existing counts without mutating the input", () => {
    const current = { a: 1, b: 2 }
    const out = applyUseBumps(current, ["a"], ["b"])
    expect(out).toEqual({ a: 2, b: 1 })
    expect(current).toEqual({ a: 1, b: 2 })
  })
  it("floors removed-below-zero at 0", () => {
    expect(applyUseBumps({ a: 0 }, [], ["a", "a"])).toEqual({ a: 0 })
  })
})
