import { describe, it, expect } from "vitest"
import { parseWindow, windowRange, parseCollections } from "@/lib/analytics/window"

// Shared time-window parser for the analytics loan + sales RPCs. Untrusted
// query params → validated windows; windowRange takes an injectable `now` so
// it's deterministic. Pin the aliases + the range math.

describe("parseWindow", () => {
  it("accepts canonical + legacy aliases, defaults unknown to 'all'", () => {
    expect(parseWindow("l7")).toBe("l7")
    expect(parseWindow("L30")).toBe("l30") // case-insensitive
    expect(parseWindow("y2026")).toBe("y2026")
    expect(parseWindow("2026")).toBe("y2026") // legacy bare-year
    expect(parseWindow("2025")).toBe("y2025")
    expect(parseWindow(null)).toBe("all")
    expect(parseWindow("garbage")).toBe("all")
  })
  it("defaults a prototype-key query param to 'all', never a prototype member", () => {
    // A bare ALIASES[lower] read would return an Object.prototype function for
    // ?window=constructor / toString / etc. — surfacing a function as a LoanWindow.
    for (const key of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
      expect(parseWindow(key)).toBe("all")
    }
  })
})

describe("windowRange", () => {
  const now = new Date("2026-06-15T12:00:00.000Z")

  it("'all' → open-ended range", () => {
    expect(windowRange("all", now)).toEqual({ startISO: null, endISO: null })
  })

  it("fixed-year windows return calendar bounds", () => {
    expect(windowRange("y2025", now)).toEqual({
      startISO: "2025-01-01T00:00:00.000Z",
      endISO: "2026-01-01T00:00:00.000Z",
    })
    expect(windowRange("y2026", now)).toEqual({
      startISO: "2026-01-01T00:00:00.000Z",
      endISO: "2027-01-01T00:00:00.000Z",
    })
  })

  it("ytd runs from Jan 1 of now's UTC year to now", () => {
    expect(windowRange("ytd", now)).toEqual({
      startISO: "2026-01-01T00:00:00.000Z",
      endISO: "2026-06-15T12:00:00.000Z",
    })
  })

  it("lN windows go back N days from now", () => {
    expect(windowRange("l7", now)).toEqual({
      startISO: "2026-06-08T12:00:00.000Z",
      endISO: "2026-06-15T12:00:00.000Z",
    })
  })
})

describe("parseCollections", () => {
  it("splits, trims, lower-cases, and drops empties", () => {
    expect(parseCollections("Topshot, AllDay ,, golazos")).toEqual(["topshot", "allday", "golazos"])
  })
  it("returns null for empty / nullish", () => {
    expect(parseCollections(null)).toBeNull()
    expect(parseCollections("   ")).toBeNull()
    expect(parseCollections(", ,")).toBeNull()
  })
})
