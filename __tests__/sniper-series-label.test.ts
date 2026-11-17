// lib/sniper/series-label.ts — every Top Shot sniper card names its series the same way (2026-10-25).
import { describe, expect, it } from "vitest"
import { topShotSeriesLabel } from "@/lib/sniper/series-label"

describe("topShotSeriesLabel", () => {
  it("maps a bare on-chain number and 'Series N' to the short label", () => {
    expect(topShotSeriesLabel("8")).toBe("25-26")
    expect(topShotSeriesLabel("Series 8")).toBe("25-26")
    expect(topShotSeriesLabel("5")).toBe("S4")
  })
  it("⛔ on-chain 0 is Series 1 on Top Shot, never a bare '0'", () => {
    expect(topShotSeriesLabel("0")).toBe("S1")
  })
  it("passes an already-labelled or unknown value through, never inventing one", () => {
    expect(topShotSeriesLabel("25-26")).toBe("25-26")
    expect(topShotSeriesLabel("S4")).toBe("S4")
    expect(topShotSeriesLabel("42")).toBe("42")
    expect(topShotSeriesLabel("")).toBe("")
    expect(topShotSeriesLabel(null)).toBe("")
  })
})
