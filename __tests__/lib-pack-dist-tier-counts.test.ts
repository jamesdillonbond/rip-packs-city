import { describe, it, expect } from "vitest"
import { readTierCounts, observedOpensFloorLabel } from "@/lib/pack-dist/tier-counts"

// lib/pack-dist/tier-counts — the v20 tier-count payload the pack page may
// publish. Shapes are dist 8643's live metadata (2026-09-25): 6,000 of 6,000
// "unopened" at 2026-08-28 while 5,727 opens had been observed before then.

const META_8643 = {
  tier_counts_updated_at: "2026-08-28T03:37:22.162Z",
  total_pack_count: 6000,
  total_unopened: 6000,
  remaining_by_tier: { common: 15000, rare: 3000 },
  original_counts_by_tier: { common: 15000, rare: 3000 },
  title: "kept elsewhere",
}

describe("readTierCounts", () => {
  it("a CONTRADICTED payload is dropped whole — no count, no tier map, no stamp", () => {
    expect(readTierCounts(META_8643, true)).toEqual({
      updatedAt: null, totalUnopened: null, totalPackCount: null, remainingByTier: null, originalByTier: null,
    })
  })

  it("an uncontradicted payload passes through unchanged (no-change arm)", () => {
    for (const flag of [false, null, undefined]) {
      expect(readTierCounts(META_8643, flag)).toEqual({
        updatedAt: "2026-08-28T03:37:22.162Z",
        totalUnopened: 6000,
        totalPackCount: 6000,
        remainingByTier: META_8643.remaining_by_tier,
        originalByTier: META_8643.original_counts_by_tier,
      })
    }
  })

  it("no metadata, or a non-object tier map, yields nulls rather than a guessed shape", () => {
    expect(readTierCounts(null, false).totalPackCount).toBeNull()
    const r = readTierCounts({ remaining_by_tier: "x", original_counts_by_tier: [1, 2] }, false)
    expect(r.remainingByTier).toBeNull()
    expect(r.originalByTier).toBeNull()
    expect(r.updatedAt).toBeNull()
  })
})

describe("observedOpensFloorLabel", () => {
  it("states the observed opens as a FLOOR, only when the counts were contradicted", () => {
    expect(observedOpensFloorLabel(true, 5877)).toBe("5,877+ opened on-chain")
    expect(observedOpensFloorLabel(false, 5877)).toBeNull()
    expect(observedOpensFloorLabel(null, 5877)).toBeNull()
  })
  it("no observed opens is no label — never '0+ opened'", () => {
    expect(observedOpensFloorLabel(true, 0)).toBeNull()
    expect(observedOpensFloorLabel(true, null)).toBeNull()
    expect(observedOpensFloorLabel(true, Number.NaN)).toBeNull()
  })
})
