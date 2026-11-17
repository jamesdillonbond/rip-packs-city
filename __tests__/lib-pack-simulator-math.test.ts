import { describe, it, expect, vi, afterEach } from "vitest"
import { tierColor, fmtUsd, fmtPct, buildCdf, sampleEdition, stddev } from "@/lib/pack-simulator-math"

describe("pack-simulator-math — tierColor", () => {
  // Moved off hardcoded hex onto the --tier-* design tokens 2026-08-01.
  it("maps by substring (case-insensitive), unknown → neutral token", () => {
    expect(tierColor("Ultimate")).toBe("var(--tier-ultimate)")
    expect(tierColor("legendary")).toBe("var(--tier-legendary)")
    expect(tierColor("Super Rare")).toBe("var(--tier-rare)")
    expect(tierColor("Challenger")).toBe("var(--tier-challenger)")
    expect(tierColor("contender")).toBe("var(--tier-contender)")
    expect(tierColor("mythic")).toBe("var(--rpc-text-muted)")
    expect(tierColor(null)).toBe("var(--rpc-text-muted)")
  })
  it("never returns a raw hex literal (design-system rule)", () => {
    for (const t of [null, "ultimate", "legendary", "rare", "fandom", "common", "challenger", "contender", "mythic"]) {
      expect(tierColor(t)).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    }
  })
})

describe("pack-simulator-math — fmtUsd / fmtPct", () => {
  it("fmtUsd: em-dash for null/non-finite, whole ≥ $1k", () => {
    expect(fmtUsd(null)).toBe("—")
    expect(fmtUsd(2500.4)).toBe("$2,500")
    expect(fmtUsd(9.5)).toBe("$9.50")
  })
  it("fmtPct: scales ×100, 2 decimals below 1%, 1 decimal at/above", () => {
    expect(fmtPct(null)).toBe("—")
    expect(fmtPct(0.005)).toBe("0.50%")
    expect(fmtPct(0.25)).toBe("25.0%")
  })
})

describe("pack-simulator-math — buildCdf", () => {
  it("accumulates weights, clamping negatives/non-numbers to 0", () => {
    const { cdf, total } = buildCdf([{ drop_weight: 1 }, { drop_weight: 1 }, { drop_weight: 2 }])
    expect(cdf).toEqual([1, 2, 4])
    expect(total).toBe(4)
  })
  it("clamps negative and null weights to 0", () => {
    const { cdf, total } = buildCdf([{ drop_weight: 3 }, { drop_weight: -5 }, { drop_weight: null }])
    expect(cdf).toEqual([3, 3, 3])
    expect(total).toBe(3)
  })
})

describe("pack-simulator-math — sampleEdition (weighted binary search)", () => {
  afterEach(() => vi.restoreAllMocks())
  const pool = [{ id: "a", drop_weight: 1 }, { id: "b", drop_weight: 1 }, { id: "c", drop_weight: 2 }]
  const { cdf, total } = buildCdf(pool) // cdf [1,2,4] total 4

  const pickWith = (rand: number) => {
    vi.spyOn(Math, "random").mockReturnValue(rand)
    return sampleEdition(pool, cdf, total).id
  }

  it("selects the bucket the scaled random draw falls into", () => {
    expect(pickWith(0)).toBe("a") // r=0 → first bucket
    expect(pickWith(0.2)).toBe("a") // r=0.8 < 1
    expect(pickWith(0.375)).toBe("b") // r=1.5 in (1,2]
    expect(pickWith(0.75)).toBe("c") // r=3 in (2,4]
    expect(pickWith(0.999)).toBe("c")
  })

  it("returns the first element for a degenerate (zero-total) pool", () => {
    const zero = [{ id: "z", drop_weight: 0 }]
    const built = buildCdf(zero)
    expect(sampleEdition(zero, built.cdf, built.total).id).toBe("z")
  })
})

describe("pack-simulator-math — stddev", () => {
  it("returns 0 for fewer than 2 values", () => {
    expect(stddev([])).toBe(0)
    expect(stddev([5])).toBe(0)
  })
  it("computes population standard deviation", () => {
    // values [2,4,4,4,5,5,7,9] → mean 5, popvar 4, std 2
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, 10)
  })
})
