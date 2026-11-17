import { describe, it, expect } from "vitest"
import { readTierCounts, observedOpensFloorLabel, atlasTierCounts, pickTierCounts } from "@/lib/pack-dist/tier-counts"

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

// Dist 5048 on 2026-10-14: v20 froze at 2026-08-28 (142 unopened); the Atlas lane
// read 134 that morning. Tier values arrive from jsonb as strings.
const META_5048 = {
  tier_counts_updated_at: "2026-08-28T10:26:00.179Z",
  total_pack_count: 22068,
  total_unopened: 142,
  remaining_by_tier: { rare: 46, common: 647, legendary: 0 },
  original_counts_by_tier: { rare: 5275, common: 104823, legendary: 240 },
}
const ATLAS_5048 = {
  summary_fetched_at: "2026-10-14T09:54:00.307Z",
  unopened_count: 134,
  total_pack_count: 22068,
  remaining_by_tier: { rare: "43", common: "627", legendary: "0" },
  original_by_tier: { rare: "5275", common: "104823", legendary: "240" },
}

describe("pickTierCounts — the live Atlas counts replace the frozen v20 payload", () => {
  it("a newer, valid Atlas row wins, with ITS stamp and numeric tier maps", () => {
    expect(pickTierCounts(META_5048, false, ATLAS_5048, 21000)).toEqual({
      updatedAt: "2026-10-14T09:54:00.307Z",
      totalUnopened: 134,
      totalPackCount: 22068,
      remainingByTier: { rare: 43, common: 627, legendary: 0 },
      originalByTier: { rare: 5275, common: 104823, legendary: 240 },
    })
  })

  it("never mixes sources: an older Atlas row leaves the whole v20 payload, stamp included", () => {
    const old = { ...ATLAS_5048, summary_fetched_at: "2026-08-01T00:00:00Z" }
    expect(pickTierCounts(META_5048, false, old, 0)).toEqual(readTierCounts(META_5048, false))
  })

  it("no Atlas row (other collections, a failed read) is exactly today's v20 behaviour", () => {
    expect(pickTierCounts(META_5048, false, null, 0)).toEqual(readTierCounts(META_5048, false))
    expect(pickTierCounts(META_5048, true, null, 0)).toEqual(readTierCounts(META_5048, true))
  })

  it("the v20 contradiction verdict does not suppress valid Atlas counts", () => {
    expect(pickTierCounts(META_5048, true, ATLAS_5048, 0).totalUnopened).toBe(134)
  })

  it("Atlas covers a dist v20 never reached", () => {
    expect(pickTierCounts(null, false, ATLAS_5048, 0).updatedAt).toBe(ATLAS_5048.summary_fetched_at)
  })
})

describe("atlasTierCounts — the same floor that refutes v20 refutes Atlas", () => {
  it("claiming fewer opened than we watched open on chain drops it WHOLE", () => {
    // 22,068 − 134 = 21,934 opened by Atlas; we observed 21,935.
    expect(atlasTierCounts(ATLAS_5048, 21935)).toBeNull()
    expect(atlasTierCounts(ATLAS_5048, 21934)).not.toBeNull()
  })

  it("an incomplete or impossible row is no answer, never a guessed shape", () => {
    expect(atlasTierCounts({ ...ATLAS_5048, summary_fetched_at: null }, 0)).toBeNull()
    expect(atlasTierCounts({ ...ATLAS_5048, unopened_count: null }, 0)).toBeNull()
    // a zero-pack dist (one exists in Atlas) publishes no counts: 0 of 0, nothing opened
    expect(atlasTierCounts({ ...ATLAS_5048, total_pack_count: 0, unopened_count: 0 }, 0)).toBeNull()
    expect(atlasTierCounts({ ...ATLAS_5048, unopened_count: -1 }, 0)).toBeNull()
    expect(atlasTierCounts({ ...ATLAS_5048, unopened_count: 30000 }, 0)).toBeNull()
    expect(atlasTierCounts({ ...ATLAS_5048, remaining_by_tier: null }, 0)).toBeNull()
    expect(atlasTierCounts({ ...ATLAS_5048, original_by_tier: { rare: "x" } }, 0)).toBeNull()
  })
})
