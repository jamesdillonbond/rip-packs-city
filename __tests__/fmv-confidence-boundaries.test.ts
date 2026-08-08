import { describe, it, expect } from "vitest"
import {
  escalateConfidence,
  MIN_SALES_30D_HIGH,
  MIN_SALES_30D_MEDIUM,
  MIN_SALES_ASK_CORROBORATION,
  HIGH_MAX_DISPERSION,
  MEDIUM_MAX_DISPERSION,
  ASK_CORROBORATION_BAND,
} from "@/lib/fmv-confidence"

// The roadmap's HEADLINE accuracy metric is "share of prices at HIGH/MEDIUM
// confidence." That share is decided entirely by escalateConfidence() and its
// threshold constants — so a silent change to any threshold, or a regression in
// the dispersion / serial-residual / ask-corroboration branch selection, moves
// the flagship number with nothing to catch it. The existing fmv-confidence
// test pins the happy paths; these pin the exact BOUNDARIES and branch choices
// the metric turns on.

describe("confidence thresholds are the metric's contract (tripwire)", () => {
  // Not arbitrary: these values are calibrated against traded-edition
  // dispersion (see lib/fmv-confidence.ts header). A change here is a deliberate
  // re-tuning of the public accuracy metric and must be a conscious, reviewed
  // edit — not an incidental diff. Update these expectations in the same commit
  // that re-tunes, and say why in the message.
  it("holds the calibrated threshold set", () => {
    expect(MIN_SALES_30D_HIGH).toBe(7)
    expect(MIN_SALES_30D_MEDIUM).toBe(5)
    expect(MIN_SALES_ASK_CORROBORATION).toBe(3)
    expect(HIGH_MAX_DISPERSION).toBe(0.2)
    expect(MEDIUM_MAX_DISPERSION).toBe(0.35)
    expect(ASK_CORROBORATION_BAND).toBe(0.25)
  })
})

describe("escalateConfidence — the volume-count boundary for HIGH", () => {
  const tight = [100, 101, 99, 100, 102, 98, 100, 100] // 8 tight prices

  it("one sale below the HIGH floor cannot be HIGH — it stays MEDIUM on the volume floor", () => {
    // count = 6 < MIN_SALES_30D_HIGH(7): the dispersion gate never runs, so even
    // perfectly tight prices can only reach MEDIUM. This is the exact row that
    // flips the HIGH share when the floor moves.
    expect(escalateConfidence("MEDIUM", MIN_SALES_30D_HIGH - 1, tight.slice(0, 6))).toBe("MEDIUM")
  })

  it("exactly at the HIGH floor with tight prices grants HIGH", () => {
    expect(escalateConfidence("MEDIUM", MIN_SALES_30D_HIGH, tight.slice(0, 7))).toBe("HIGH")
  })

  it("count>=HIGH but too FEW prices to fit leaves the dispersion gate unrun (stays MEDIUM)", () => {
    // The gate also requires prices.length >= MIN_SALES_30D_HIGH; a high sales
    // count with a short price vector must NOT be graded HIGH on thin evidence.
    expect(escalateConfidence("MEDIUM", 12, [100, 100, 100])).toBe("MEDIUM")
  })
})

describe("escalateConfidence — the dispersion grading band (count>=7)", () => {
  it("grades the mid dispersion band to MEDIUM, not HIGH and not LOW", () => {
    // CV of this set is ~0.24 — inside [HIGH_MAX_DISPERSION, MEDIUM_MAX_DISPERSION).
    const midBand = [60, 80, 100, 120, 140, 100, 100]
    expect(escalateConfidence("MEDIUM", 7, midBand)).toBe("MEDIUM")
  })

  it("demotes to LOW above the MEDIUM dispersion ceiling despite ample volume", () => {
    const noisy = [10, 200, 5, 300, 1, 500, 50]
    expect(escalateConfidence("MEDIUM", 7, noisy)).toBe("LOW")
  })
})

describe("escalateConfidence — serial-residual gate is preferred over raw CV", () => {
  const priceRamp = [10, 20, 30, 40, 50, 60, 70] // raw CV ~0.5 -> LOW on its own
  const serials = [1, 2, 3, 4, 5, 6, 7]

  it("a wide raw price spread that is FULLY explained by serial resolves to HIGH", () => {
    // ln(price) is exactly linear in ln(serial) -> residual ~0 -> HIGH, even
    // though the raw coefficient of variation would demote it. This is the whole
    // point of the serial-residual gate (a #1 and a #25000 legitimately trade
    // far apart; that spread is structure, not pricing noise).
    expect(escalateConfidence("MEDIUM", 7, priceRamp, serials)).toBe("HIGH")
  })

  it("falls back to raw CV (LOW) when the serials array length does not match prices", () => {
    // The gate only trusts serials when serials.length === prices.length; a
    // mismatched serials vector must not be half-applied.
    expect(escalateConfidence("MEDIUM", 7, priceRamp, [1, 2, 3])).toBe("LOW")
  })
})

describe("escalateConfidence — ask-corroboration edges", () => {
  it("does NOT fire below the ask-corroboration sales floor", () => {
    // 2 sales (< MIN_SALES_ASK_CORROBORATION) -> even a spot-on ask cannot rescue.
    expect(escalateConfidence("LOW", 2, [100, 100], undefined, 100)).toBe("LOW")
  })

  it("fires at the inclusive edge of the corroboration band", () => {
    // median 100, ask 80 -> ratio 1.25 == 1 + ASK_CORROBORATION_BAND (inclusive).
    expect(escalateConfidence("LOW", 4, [100, 100, 100, 100], undefined, 80)).toBe("MEDIUM")
  })

  it("does not fire just outside the band", () => {
    // median 100, ask 70 -> ratio ~1.43 > 1.25.
    expect(escalateConfidence("LOW", 4, [100, 100, 100, 100], undefined, 70)).toBe("LOW")
  })

  it("rescues a dispersion-DEMOTED (count>=7) edition when a live ask agrees", () => {
    // noisy prices demote count>=7 to LOW; a live ask near the median then
    // rescues it to MEDIUM (documented: covers the count>=7 demoted case).
    const noisy = [10, 200, 5, 300, 1, 500, 50] // sorted median = 50
    expect(escalateConfidence("MEDIUM", 7, noisy, undefined, 50)).toBe("MEDIUM")
  })

  it("never LOWERS an already-HIGH/MEDIUM edition (ask is a floor, corroborate-only)", () => {
    const tight = [100, 101, 99, 100, 102, 98, 100]
    // A far-off lowball ask must not touch a HIGH edition.
    expect(escalateConfidence("MEDIUM", 7, tight, undefined, 5)).toBe("HIGH")
  })
})
