import { describe, it, expect } from "vitest"
import { getSerialTraits, getPrimarySerialTrait } from "@/lib/serial-utils"

// Special-serial trait derivation (#1 / Perfect Mint / Jersey Match / Low
// Serial) used across sniper + moment surfaces. Pin the thresholds + priority.

describe("getSerialTraits", () => {
  it("#1 serial gets '#1' and 'Low Serial'", () => {
    expect(getSerialTraits(1, 100)).toEqual(["#1", "Low Serial"])
  })

  it("last serial (serial === mintSize) gets 'Perfect Mint'", () => {
    expect(getSerialTraits(100, 100)).toEqual(["Perfect Mint"])
  })

  it("jersey match adds 'Jersey Match'", () => {
    expect(getSerialTraits(23, 1000, 23)).toEqual(["Jersey Match"])
  })

  it("'Low Serial' threshold is max(5, 1% of mint)", () => {
    // mint 1000 → threshold max(5, 10) = 10; serial 10 qualifies, 11 does not
    expect(getSerialTraits(10, 1000)).toContain("Low Serial")
    expect(getSerialTraits(11, 1000)).not.toContain("Low Serial")
    // small mint → floor is 5
    expect(getSerialTraits(5, 100)).toContain("Low Serial")
    expect(getSerialTraits(6, 100)).not.toContain("Low Serial")
  })

  it("ordinary mid-edition serial gets no traits", () => {
    expect(getSerialTraits(500, 1000)).toEqual([])
  })
})

describe("getPrimarySerialTrait", () => {
  it("prioritizes #1 > Perfect Mint > Jersey Match", () => {
    expect(getPrimarySerialTrait(["Jersey Match", "#1"])).toBe("#1")
    expect(getPrimarySerialTrait(["Perfect Mint", "Jersey Match"])).toBe("Perfect Mint")
    expect(getPrimarySerialTrait(["Jersey Match"])).toBe("Jersey Match")
    expect(getPrimarySerialTrait(["Low Serial"])).toBeNull()
    expect(getPrimarySerialTrait([])).toBeNull()
  })
})
