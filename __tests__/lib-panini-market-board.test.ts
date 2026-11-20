import { describe, it, expect } from "vitest"
import { paniniStoredBoardIsFresh, PANINI_BOARD_MAX_AGE_MS } from "@/lib/panini/market-board"

const NOW = Date.parse("2026-11-20T06:00:00Z")
const at = (msAgo: number) => [{ computed_at: new Date(NOW - msAgo).toISOString() }]

describe("paniniStoredBoardIsFresh", () => {
  it("accepts a copy inside the bound and refuses one past it", () => {
    expect(paniniStoredBoardIsFresh(at(15 * 60_000), NOW)).toBe(true)
    expect(paniniStoredBoardIsFresh(at(PANINI_BOARD_MAX_AGE_MS), NOW)).toBe(true)
    expect(paniniStoredBoardIsFresh(at(PANINI_BOARD_MAX_AGE_MS + 1), NOW)).toBe(false)
  })
  it("refuses a failed read and rows whose age cannot be read", () => {
    expect(paniniStoredBoardIsFresh(null, NOW)).toBe(false)
    expect(paniniStoredBoardIsFresh([{}], NOW)).toBe(false)
    expect(paniniStoredBoardIsFresh([{ computed_at: "not a date" }], NOW)).toBe(false)
  })
  it("an empty result is usable (a filter that matches nothing)", () => {
    expect(paniniStoredBoardIsFresh([], NOW)).toBe(true)
  })
})
