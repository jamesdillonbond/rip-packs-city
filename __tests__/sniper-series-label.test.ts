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

describe("allDaySeriesLabel (2026-11-24)", () => {
  it("decodes All Day's bare on-chain number to the contract's own name", async () => {
    const { allDaySeriesLabel } = await import("@/lib/sniper/series-label")
    expect(allDaySeriesLabel("7")).toBe("2024 Season")
    expect(allDaySeriesLabel("9")).toBe("2025 Season")
    expect(allDaySeriesLabel("2")).toBe("Historical")
    expect(allDaySeriesLabel("7")).not.toBe("7")
  })
  it("never re-maps an official name — the marketplace's 'Series 2' is on-chain 3", async () => {
    const { allDaySeriesLabel } = await import("@/lib/sniper/series-label")
    expect(allDaySeriesLabel("Series 2")).toBe("Series 2")
    expect(allDaySeriesLabel("2025 Season")).toBe("2025 Season")
    expect(allDaySeriesLabel("")).toBe("")
    expect(allDaySeriesLabel(null)).toBe("")
    expect(allDaySeriesLabel("42")).toBe("42")
  })
})
