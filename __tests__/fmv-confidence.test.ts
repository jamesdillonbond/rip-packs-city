import { describe, it, expect } from "vitest"
import {
  computeConfidence,
  escalateConfidence,
  gateHighToRecentVolume,
  gateMediumToRecentSale,
  serialResidualDispersion,
  MIN_SALES_30D_HIGH,
} from "@/lib/fmv-confidence"

// The canonical FMV confidence-tier logic — the single source of truth shared
// by fmv-recalc and fmv-backfill (they drifted before this was extracted).
// Pin the volume floors, the dispersion HIGH/MEDIUM/LOW grading, and the
// ask-corroboration LOW→MEDIUM rescue.

describe("computeConfidence (volume-only base tier)", () => {
  it("never assigns HIGH; MEDIUM at >=5 sales, else LOW", () => {
    expect(computeConfidence(0)).toBe("LOW")
    expect(computeConfidence(4)).toBe("LOW")
    expect(computeConfidence(5)).toBe("MEDIUM")
    expect(computeConfidence(50)).toBe("MEDIUM")
  })
})

describe("escalateConfidence", () => {
  const tight = [100, 101, 99, 100, 102, 98, 100] // low dispersion, 7 sales
  const noisy = [10, 200, 5, 300, 1, 500, 50] // high dispersion, 7 sales

  it("stays LOW below the MEDIUM volume floor", () => {
    expect(escalateConfidence("LOW", 3, [100, 100, 100])).toBe("LOW")
  })

  it("lifts to MEDIUM on the volume floor (5-6 sales, no fit yet)", () => {
    expect(escalateConfidence("LOW", 5, [100, 100, 100, 100, 100])).toBe("MEDIUM")
  })

  it("grants HIGH when volume >=7 AND dispersion is tight", () => {
    expect(escalateConfidence("MEDIUM", 7, tight)).toBe("HIGH")
  })

  it("demotes to LOW when volume is high but prices are too noisy", () => {
    expect(escalateConfidence("MEDIUM", 7, noisy)).toBe("LOW")
  })

  it("ask-corroboration rescues LOW→MEDIUM when the sales median agrees with a live ask", () => {
    // 4 sales (below MEDIUM floor) but a live ask within ±25% of the median
    const prices = [100, 100, 100, 100]
    expect(escalateConfidence("LOW", 4, prices, undefined, 110)).toBe("MEDIUM")
  })

  it("ask-corroboration does NOT fire when the ask is far from the median", () => {
    expect(escalateConfidence("LOW", 4, [100, 100, 100, 100], undefined, 1000)).toBe("LOW")
  })
})

describe("serialResidualDispersion", () => {
  it("returns null when fewer than MIN_SALES_30D_HIGH sales carry a usable serial", () => {
    expect(serialResidualDispersion([100, 200], [1, 2])).toBeNull()
  })

  it("returns ~0 for a clean power-law price/serial relationship", () => {
    // price = e^2 * serial^0.5 → ln(price) is exactly linear in ln(serial)
    const serials = Array.from({ length: MIN_SALES_30D_HIGH }, (_, i) => i + 1)
    const prices = serials.map((s) => Math.exp(2) * Math.pow(s, 0.5))
    const disp = serialResidualDispersion(prices, serials)
    expect(disp).not.toBeNull()
    expect(disp!).toBeLessThan(1e-6)
  })
})

describe("gateHighToRecentVolume (HIGH stays >=7 sales/30d)", () => {
  it("demotes HIGH to MEDIUM when the true 30d count is below the HIGH floor", () => {
    // A 90d-widened edition earned HIGH on wide volume but has only 3 in 30d.
    expect(gateHighToRecentVolume("HIGH", 3)).toBe("MEDIUM")
    expect(gateHighToRecentVolume("HIGH", MIN_SALES_30D_HIGH - 1)).toBe("MEDIUM")
  })
  it("keeps HIGH when the 30d count clears the floor (recent + liquid)", () => {
    expect(gateHighToRecentVolume("HIGH", MIN_SALES_30D_HIGH)).toBe("HIGH")
    expect(gateHighToRecentVolume("HIGH", 20)).toBe("HIGH")
  })
  it("passes every non-HIGH confidence through untouched", () => {
    for (const c of ["MEDIUM", "LOW", "ASK_ONLY", "STALE", "NO_DATA", "SALES_ONLY"]) {
      expect(gateHighToRecentVolume(c, 0)).toBe(c)
      expect(gateHighToRecentVolume(c, 99)).toBe(c)
    }
  })
})

describe("gateMediumToRecentSale (1.8.2: MEDIUM needs a sale in the last 30 days)", () => {
  it("demotes MEDIUM to LOW when there is no sale in the true 30-day window", () => {
    // The 90d-widened MEDIUM: backtested 10-17 at 20.0 % vs 14.0 % median error (Top Shot).
    expect(gateMediumToRecentSale("MEDIUM", 0)).toBe("LOW")
  })
  it("⛔ an UNKNOWN 30-day count (null) leaves the label alone — never read as zero", () => {
    expect(gateMediumToRecentSale("MEDIUM", null)).toBe("MEDIUM")
    expect(gateMediumToRecentSale("HIGH", null)).toBe("HIGH")
  })
  it("keeps MEDIUM with at least one recent sale", () => {
    expect(gateMediumToRecentSale("MEDIUM", 1)).toBe("MEDIUM")
    expect(gateMediumToRecentSale("MEDIUM", 12)).toBe("MEDIUM")
  })
  it("chained after the HIGH gate, a HIGH with no recent sale lands on LOW, not MEDIUM", () => {
    expect(gateMediumToRecentSale(gateHighToRecentVolume("HIGH", 0), 0)).toBe("LOW")
    expect(gateMediumToRecentSale(gateHighToRecentVolume("HIGH", 3), 3)).toBe("MEDIUM")
    expect(gateMediumToRecentSale(gateHighToRecentVolume("HIGH", 9), 9)).toBe("HIGH")
  })
  it("passes every non-MEDIUM confidence through untouched", () => {
    for (const c of ["HIGH", "LOW", "ASK_ONLY", "STALE", "NO_DATA", "SALES_ONLY"]) {
      expect(gateMediumToRecentSale(c, 0)).toBe(c)
      expect(gateMediumToRecentSale(c, 99)).toBe(c)
    }
  })
})

describe("fmv-recalc applies the MEDIUM recency gate at every confidence write", () => {
  it("each gateHighToRecentVolume call in the route is paired with gateMediumToRecentSale", async () => {
    const { readFileSync } = await import("node:fs")
    const path = await import("node:path")
    const src = readFileSync(path.join(path.resolve(__dirname, ".."), "app/api/fmv-recalc/route.ts"), "utf8")
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")
    const high = (code.match(/gateHighToRecentVolume\(/g) ?? []).length
    const medium = (code.match(/gateMediumToRecentSale\(/g) ?? []).length
    expect(high, "the route no longer calls the HIGH gate - re-anchor this test").toBeGreaterThan(0)
    expect(medium, "a confidence write applies the HIGH recency gate but not the MEDIUM one").toBe(high)
  })
})
