import { describe, it, expect } from "vitest"
import { paniniRunMode, ptHour } from "@/lib/chains/panini/run-mode"

// 2026-10-03: the residential task runs every 2 h; the old 4-hourly slots (2/6/10 AM-PM PT) stay FULL
// runs (grids + packs + cards), the new in-between slots (12/4/8 AM-PM PT) are WALK-only runs.

describe("panini run mode", () => {
  it("reads the PT hour across daylight and standard time", () => {
    expect(ptHour(new Date("2026-10-04T07:00:00Z"))).toBe(0) // PDT, UTC-7
    expect(ptHour(new Date("2026-12-01T08:00:00Z"))).toBe(0) // PST, UTC-8
    expect(ptHour(new Date("2026-10-03T21:01:47Z"))).toBe(14) // the 2:00 PM PT run's GET
  })

  it("the old 4-hourly slots stay FULL, the new in-between slots are WALK", () => {
    const at = (iso: string) => paniniRunMode(new Date(iso), undefined)
    expect(at("2026-10-04T09:00:10Z")).toBe("full") // 2 AM PT
    expect(at("2026-10-04T13:00:10Z")).toBe("full") // 6 AM PT
    expect(at("2026-10-04T01:00:10Z")).toBe("full") // 6 PM PT
    expect(at("2026-10-04T07:00:10Z")).toBe("walk") // midnight PT
    expect(at("2026-10-04T11:00:10Z")).toBe("walk") // 4 AM PT
    expect(at("2026-10-03T23:00:10Z")).toBe("walk") // 4 PM PT
    expect(at("2026-10-04T03:00:10Z")).toBe("walk") // 8 PM PT
    expect(at("2026-12-01T16:00:10Z")).toBe("walk") // 8 AM PST
  })

  it("a late catch-up start at an odd hour is FULL (discovery is never silently skipped twice)", () => {
    expect(paniniRunMode(new Date("2026-10-04T08:30:00Z"), undefined)).toBe("full") // 1:30 AM PT
  })

  it("PANINI_RUN_MODE pins it; anything else is the clock", () => {
    expect(paniniRunMode(new Date("2026-10-04T09:00:00Z"), "walk")).toBe("walk")
    expect(paniniRunMode(new Date("2026-10-04T07:00:00Z"), "full")).toBe("full")
    expect(paniniRunMode(new Date("2026-10-04T07:00:00Z"), "auto")).toBe("walk")
  })
})
