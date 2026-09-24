import { describe, it, expect } from "vitest"
import { isLeague, LEAGUES } from "@/lib/teams"

// Locks the one pure export from lib/teams.ts: isLeague, the League type guard
// accepting exactly NBA/WNBA/NFL/LALIGA/MLB and rejecting everything else. Also
// pins the LEAGUES option list so its values stay in sync with the guard.

describe("isLeague", () => {
  it("accepts the five valid league codes", () => {
    expect(isLeague("NBA")).toBe(true)
    expect(isLeague("WNBA")).toBe(true)
    expect(isLeague("NFL")).toBe(true)
    expect(isLeague("LALIGA")).toBe(true)
    // MLB joined 2026-09-23 (franchise hubs; Candy MLB). It used to be this
    // file's "unknown league" sentinel — that role moved to NHL below.
    expect(isLeague("MLB")).toBe(true)
  })

  it("rejects wrong case, unknown strings, and non-strings", () => {
    expect(isLeague("nba")).toBe(false)
    expect(isLeague("NHL")).toBe(false)
    expect(isLeague("mlb")).toBe(false)
    expect(isLeague("")).toBe(false)
    expect(isLeague(null)).toBe(false)
    expect(isLeague(undefined)).toBe(false)
    expect(isLeague(123)).toBe(false)
    expect(isLeague({})).toBe(false)
  })

  it("every LEAGUES option value passes isLeague", () => {
    for (const l of LEAGUES) {
      expect(isLeague(l.value)).toBe(true)
    }
  })
})
