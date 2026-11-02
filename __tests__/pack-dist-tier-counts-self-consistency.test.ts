import { describe, it, expect } from "vitest"
import { atlasTierCounts, isSelfConsistent } from "@/lib/pack-dist/tier-counts"

// Dapper's tier payload must agree with itself (2026-11-02). Real payloads, read 11-02:
// 6409 Origins Standard mixes two bases (unopened on total_supply, tier maps on
// total_pack_count) and is rejected; ordinary drops pass.

const sum = (o: Record<string, number>) => o
describe("isSelfConsistent", () => {
  it("rejects the Origins Standard payload (mixed bases)", () => {
    expect(isSelfConsistent(sum({ common: 5815 }), sum({ common: 81300 }), 2404, 16260)).toBe(false)
  })
  it("rejects the Origins topper payload", () => {
    expect(isSelfConsistent(sum({ rare: 67 }), sum({ rare: 2252 }), 315, 2252)).toBe(false)
  })
  it("accepts ordinary drops exactly or nearly consistent", () => {
    expect(isSelfConsistent(sum({ common: 1710, rare: 43, legendary: 2 }), sum({ common: 4395, rare: 102, legendary: 3 }), 585, 1500)).toBe(true) // 8905
    expect(isSelfConsistent(sum({ common: 1850 }), sum({ common: 22000 }), 370, 4400)).toBe(true) // 8770
    expect(isSelfConsistent(sum({ x: 669 }), sum({ x: 29985 }), 223, 9995)).toBe(true) // 6418
    expect(isSelfConsistent(sum({ x: 3440 }), sum({ x: 3633 }), 1000, 1000)).toBe(true) // variable-slot, 5 % off
  })
  it("is vacuous only where it must be (no unopened / no launch moments)", () => {
    expect(isSelfConsistent(sum({}), sum({}), 0, 100)).toBe(true)
  })
})

describe("atlasTierCounts drops an inconsistent payload whole", () => {
  const base = { summary_fetched_at: "2026-11-01T09:49:00Z", unopened_count: 2404, total_pack_count: 16260 }
  it("6409 → null even with no observed floor", () => {
    expect(atlasTierCounts({ ...base, remaining_by_tier: { common: "5815" }, original_by_tier: { common: "81300" } }, 0)).toBeNull()
  })
  it("a consistent payload still renders", () => {
    expect(atlasTierCounts({ summary_fetched_at: "2026-11-01T09:49:00Z", unopened_count: 585, total_pack_count: 1500, remaining_by_tier: { common: "1755" }, original_by_tier: { common: "4500" } }, 915)).not.toBeNull()
  })
})
