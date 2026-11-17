import { describe, it, expect } from "vitest"
import { fmvSerialMultiplier } from "@/lib/fmv/serial-multiplier"
import { sniperSerialMultiplier } from "@/lib/sniper/serial-multiplier"

// Pins the two per-serial weighting functions (FMV API valuation + sniper-feed
// display signal). Their SPECIAL-serial multipliers intentionally differ; their
// ORDINARY-serial curve is documented to agree. The final describe block locks
// that agreement so the shared formula can't silently drift apart.

describe("fmvSerialMultiplier (FMV API valuation)", () => {
  it("pins the special-serial tiers", () => {
    expect(fmvSerialMultiplier(1, 1000)).toBe(12.0)
    expect(fmvSerialMultiplier(10, 1000)).toBe(4.5)
    expect(fmvSerialMultiplier(23, 1000)).toBe(2.8)
    expect(fmvSerialMultiplier(1000, 1000)).toBe(3.0) // last serial (serial === circ)
  })

  it("tier boundaries: 11 falls out of the ≤10 tier, into ≤23", () => {
    expect(fmvSerialMultiplier(11, 1000)).toBe(2.8)
    expect(fmvSerialMultiplier(24, 1000)).toBeLessThan(2.8)
  })

  it("ordinary serials ride the smooth 1.0 + 0.08·(1 - position) curve", () => {
    // serial 500 of 1000 → position 0.5 → 1.0 + 0.08*0.5 = 1.04
    expect(fmvSerialMultiplier(500, 1000)).toBeCloseTo(1.04, 6)
  })

  it("guards divide-by-zero circulation (position → 0.5)", () => {
    expect(fmvSerialMultiplier(50, 0)).toBeCloseTo(1.04, 6)
  })
})

describe("sniperSerialMultiplier (sniper display signal)", () => {
  it("pins the special-serial multipliers + signals", () => {
    expect(sniperSerialMultiplier(1, 1000, null)).toEqual({ mult: 8, signal: "#1", isSpecial: true })
    expect(sniperSerialMultiplier(1000, 1000, null)).toEqual({
      mult: 1.3,
      signal: "Last #1000",
      isSpecial: true,
    })
  })

  it("flags a jersey-match serial", () => {
    expect(sniperSerialMultiplier(23, 1000, 23)).toEqual({
      mult: 2.5,
      signal: "Jersey #23",
      isSpecial: true,
    })
  })

  it("#1 takes priority over a jersey match at serial 1", () => {
    expect(sniperSerialMultiplier(1, 1000, 1).signal).toBe("#1")
  })

  it("ordinary serials get no signal and ride the shared curve", () => {
    const r = sniperSerialMultiplier(500, 1000, null)
    expect(r.isSpecial).toBe(false)
    expect(r.signal).toBeNull()
    expect(r.mult).toBeCloseTo(1.04, 4)
  })
})

describe("cross-route agreement on ORDINARY serials (documented invariant)", () => {
  it("both functions produce the same ordinary-serial curve value", () => {
    // Use serials that are ordinary in BOTH functions (not 1, not ≤23 for FMV,
    // not === circ). For circ 1000, serials 24..999 are ordinary in both.
    for (const serial of [24, 100, 250, 500, 750, 999]) {
      const fmv = fmvSerialMultiplier(serial, 1000)
      const sniper = sniperSerialMultiplier(serial, 1000, null).mult
      // sniper rounds to 4dp; compare at that precision.
      expect(sniper).toBeCloseTo(fmv, 4)
    }
  })
})
