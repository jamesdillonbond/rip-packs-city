import { describe, it, expect } from "vitest"
import { pieceListHeader } from "@/lib/sets/piece-list-header"

// 2026-11-14: a truncated preview's header stated its LENGTH as the set's total.
describe("pieceListHeader", () => {
  it("states the server's total and how many are listed when the list is a preview", () => {
    expect(pieceListHeader("MISSING", 5, 40)).toBe("MISSING (40 · SHOWING 5)")
  })
  it("a complete list reads as before", () => {
    expect(pieceListHeader("OWNED", 4, 4)).toBe("OWNED (4)")
  })
  it("an absent or inconsistent total falls back to the listed count, never below it", () => {
    expect(pieceListHeader("MISSING", 5, undefined)).toBe("MISSING (5)")
    expect(pieceListHeader("MISSING", 5, 3)).toBe("MISSING (5)")
  })
})
