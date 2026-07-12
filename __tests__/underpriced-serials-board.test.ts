import { describe, it, expect } from "vitest"
import {
  parseHeadlineMode,
  parseQuality,
  parseSort,
} from "@/lib/underpriced-serials-board"

// Underpriced #1s / perfect-mints board query-param parsers. Locks the exact
// fallback: unlike serial-premiums-board (which defaults to "no1"), the headline
// mode here defaults to "all"; "first" is an alias for "no1"; all three parsers
// are case/whitespace-insensitive and fall through to their default.

describe("parseHeadlineMode", () => {
  it("maps no1/first → no1, perfect → perfect, everything else → all", () => {
    expect(parseHeadlineMode("no1")).toBe("no1")
    expect(parseHeadlineMode("first")).toBe("no1")
    expect(parseHeadlineMode("perfect")).toBe("perfect")
    expect(parseHeadlineMode("all")).toBe("all")
    expect(parseHeadlineMode(null)).toBe("all")
    expect(parseHeadlineMode(undefined)).toBe("all")
    expect(parseHeadlineMode("bogus")).toBe("all")
  })

  it("is case- and whitespace-insensitive", () => {
    expect(parseHeadlineMode("  PERFECT ")).toBe("perfect")
    expect(parseHeadlineMode("First")).toBe("no1")
  })
})

describe("parseQuality", () => {
  it("only tight/coarse pass through; else → all", () => {
    expect(parseQuality("tight")).toBe("tight")
    expect(parseQuality("coarse")).toBe("coarse")
    expect(parseQuality("all")).toBe("all")
    expect(parseQuality(null)).toBe("all")
    expect(parseQuality("TIGHT")).toBe("tight")
    expect(parseQuality("nonsense")).toBe("all")
  })
})

describe("parseSort", () => {
  it("ask/recent pass through; default (incl. 'discount') → discount", () => {
    expect(parseSort("ask")).toBe("ask")
    expect(parseSort("recent")).toBe("recent")
    expect(parseSort("discount")).toBe("discount")
    expect(parseSort(null)).toBe("discount")
    expect(parseSort("Recent")).toBe("recent")
    expect(parseSort("whatever")).toBe("discount")
  })
})
