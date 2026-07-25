import { describe, it, expect } from "vitest"
import {
  PREMIUM_MIN_MULT,
  fmtMult,
  siblingBaseFmv,
  premiumMultiple,
  isPremiumShown,
  hasAnyPremium,
  pillName,
} from "@/lib/entity-parallel-tier-format"

// Pins the pure premium-multiple / label / threshold logic lifted out of
// components/entity/ParallelTierSwitcher.tsx (invisible to the coverage
// ratchet). A regression mis-computes a parallel printing's premium vs
// Standard, mislabels a pill, or wrongly shows/hides the premium chip + drill-in.

type Sib = {
  external_id: string
  subedition_id: number | null
  subedition_name: string | null
  fmv_usd: number | null
}

const standard = (fmv: number | null): Sib => ({
  external_id: "12:34",
  subedition_id: null,
  subedition_name: null,
  fmv_usd: fmv,
})
const parallel = (name: string, fmv: number | null, id = 1): Sib => ({
  external_id: `12:34::${id}`,
  subedition_id: id,
  subedition_name: name,
  fmv_usd: fmv,
})

describe("fmtMult", () => {
  it("one decimal below 10", () => {
    expect(fmtMult(1.3)).toBe("1.3×")
    expect(fmtMult(3.45)).toBe("3.5×")
    expect(fmtMult(9.99)).toBe("10.0×")
  })
  it("whole number with grouping at 10 and above", () => {
    expect(fmtMult(10)).toBe("10×")
    expect(fmtMult(29.6)).toBe("30×")
    expect(fmtMult(1200)).toBe("1,200×")
  })
})

describe("siblingBaseFmv", () => {
  it("returns the Standard printing's FMV (no subedition_name)", () => {
    expect(siblingBaseFmv([standard(50), parallel("Hexwave", 900)])).toBe(50)
  })
  it("returns null when there is no Standard printing", () => {
    expect(siblingBaseFmv([parallel("Hexwave", 900), parallel("Jukebox", 700, 2)])).toBeNull()
  })
  it("returns null when Standard is unpriced", () => {
    expect(siblingBaseFmv([standard(null), parallel("Hexwave", 900)])).toBeNull()
  })
})

describe("premiumMultiple", () => {
  it("computes parallel FMV / Standard FMV for a priced parallel", () => {
    expect(premiumMultiple(parallel("Hexwave", 900), 50)).toBe(18)
  })
  it("null when baseFmv is null or zero", () => {
    expect(premiumMultiple(parallel("Hexwave", 900), null)).toBeNull()
    expect(premiumMultiple(parallel("Hexwave", 900), 0)).toBeNull()
  })
  it("null when the parallel is unpriced", () => {
    expect(premiumMultiple(parallel("Hexwave", null), 50)).toBeNull()
  })
  it("null for the Standard printing itself (no subedition_name)", () => {
    expect(premiumMultiple(standard(50), 50)).toBeNull()
  })
})

describe("isPremiumShown", () => {
  it("false for null or below the threshold", () => {
    expect(isPremiumShown(null)).toBe(false)
    expect(isPremiumShown(1.29)).toBe(false)
  })
  it("true at or above the threshold", () => {
    expect(isPremiumShown(PREMIUM_MIN_MULT)).toBe(true)
    expect(isPremiumShown(18)).toBe(true)
  })
})

describe("hasAnyPremium", () => {
  it("true when a parallel clears the threshold vs Standard", () => {
    expect(hasAnyPremium([standard(50), parallel("Hexwave", 900)])).toBe(true)
  })
  it("false when all parallels are near parity", () => {
    expect(hasAnyPremium([standard(50), parallel("Hexwave", 55)])).toBe(false) // 1.1×
  })
  it("false with no Standard denominator", () => {
    expect(hasAnyPremium([parallel("Hexwave", 900), parallel("Jukebox", 700, 2)])).toBe(false)
  })
})

describe("pillName", () => {
  it("uses subedition_name when present", () => {
    expect(pillName(parallel("Hexwave", 900))).toBe("Hexwave")
  })
  it("'Parallel #<id>' for a parallel key with no name", () => {
    expect(pillName({ external_id: "12:34::7", subedition_id: 7, subedition_name: null })).toBe("Parallel #7")
  })
  it("'Parallel #?' when the id is missing", () => {
    expect(pillName({ external_id: "12:34::9", subedition_id: null, subedition_name: null })).toBe("Parallel #?")
  })
  it("'Standard' for a non-parallel key with no name", () => {
    expect(pillName({ external_id: "12:34", subedition_id: null, subedition_name: null })).toBe("Standard")
  })
})
