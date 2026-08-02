import { describe, it, expect } from "vitest"
import { fmtList } from "@/lib/pinnacle/catalog-format"

// Pins the jsonb/text-array formatter lifted out of the Disney Pinnacle moment
// page. The parse-with-fallback + dedupe path is the interesting logic.

describe("fmtList", () => {
  it("returns the em-dash placeholder for null/undefined/empty", () => {
    expect(fmtList(null)).toBe("—")
    expect(fmtList(undefined)).toBe("—")
    expect(fmtList("")).toBe("—")
    expect(fmtList("   ")).toBe("—")
  })
  it("parses a JSON array string and joins it", () => {
    expect(fmtList('["GOLD"]')).toBe("GOLD")
    expect(fmtList('["GOLD","LED GLITCH"]')).toBe("GOLD, LED GLITCH")
  })
  it("de-duplicates genuine repeats, first occurrence wins", () => {
    expect(fmtList('["LED MARQUEE","LED MARQUEE"]')).toBe("LED MARQUEE")
    expect(fmtList('["A","B","A"]')).toBe("A, B")
  })
  it("returns the raw string when JSON is malformed (never throws)", () => {
    expect(fmtList('["GOLD"')).toBe('["GOLD"')
  })
  it("passes a plain non-bracket string through as-is", () => {
    expect(fmtList("GOLD")).toBe("GOLD")
    expect(fmtList("  GOLD  ")).toBe("GOLD")
  })
  it("accepts an actual array value", () => {
    expect(fmtList(["GOLD", "SILVER"])).toBe("GOLD, SILVER")
    expect(fmtList(["X", "X"])).toBe("X")
  })
  it("returns the placeholder for an empty array (parsed or literal)", () => {
    expect(fmtList("[]")).toBe("—")
    expect(fmtList([])).toBe("—")
  })
})
