import { describe, it, expect } from "vitest"
import {
  deterministicShuffle,
  assignTeamsToSpots,
  CANONICAL_NBA_TEAMS,
} from "@/lib/breaks/draft-shuffle"

// Seeded Fisher-Yates for team-draft breaks. Fairness is auditable ONLY if the
// same on-chain seed always yields the same assignment — pin determinism, the
// permutation property, and the spot-count guard.

const seedA = Buffer.from("a".repeat(64), "hex") // 32 bytes
const seedB = Buffer.from("b".repeat(64), "hex")

describe("deterministicShuffle", () => {
  it("is deterministic: same items + same seed → identical output", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(deterministicShuffle(items, seedA)).toEqual(deterministicShuffle(items, seedA))
  })

  it("is a permutation (same multiset, no loss/dupe)", () => {
    const items = Array.from({ length: 30 }, (_, i) => i)
    const out = deterministicShuffle(items, seedA)
    expect(out.slice().sort((a, b) => a - b)).toEqual(items)
  })

  it("different seeds generally produce different orderings", () => {
    const items = Array.from({ length: 30 }, (_, i) => i)
    expect(deterministicShuffle(items, seedA)).not.toEqual(deterministicShuffle(items, seedB))
  })

  it("does not mutate the input array", () => {
    const items = [1, 2, 3]
    const copy = items.slice()
    deterministicShuffle(items, seedA)
    expect(items).toEqual(copy)
  })
})

describe("assignTeamsToSpots", () => {
  it("returns spotCount teams, deterministically", () => {
    const out = assignTeamsToSpots([...CANONICAL_NBA_TEAMS], 8, seedA)
    expect(out).toHaveLength(8)
    expect(assignTeamsToSpots([...CANONICAL_NBA_TEAMS], 8, seedA)).toEqual(out)
  })

  it("throws when spotCount exceeds the pool", () => {
    expect(() => assignTeamsToSpots(["a", "b"], 3, seedA)).toThrow(/exceeds teamPool/)
  })
})

describe("CANONICAL_NBA_TEAMS", () => {
  it("has all 30 franchises and is frozen", () => {
    expect(CANONICAL_NBA_TEAMS).toHaveLength(30)
    expect(Object.isFrozen(CANONICAL_NBA_TEAMS)).toBe(true)
    expect(CANONICAL_NBA_TEAMS).toContain("Portland Trail Blazers")
  })
})
