import { describe, it, expect } from "vitest"
import { leagueForEdition, leagueForSetName, WNBA_ONLY_SETS } from "@/lib/league"

// NBA/WNBA derivation from a set name. This list is mirrored in the
// upsert_wallet_moments RPC (server-side league denorm); the sniper feed uses
// THIS file, so drift makes the two disagree about the same moment. Pin it.

describe("leagueForSetName", () => {
  it("returns WNBA for any set whose name contains 'wnba' (case-insensitive)", () => {
    expect(leagueForSetName("WNBA Origins")).toBe("WNBA")
    expect(leagueForSetName("something wnba something")).toBe("WNBA")
  })

  it("returns WNBA for the explicit WNBA-only set list", () => {
    for (const set of WNBA_ONLY_SETS) {
      expect(leagueForSetName(set)).toBe("WNBA")
    }
    expect(leagueForSetName("Rise With Us")).toBe("WNBA")
    expect(leagueForSetName("In Her Bag")).toBe("WNBA")
  })

  it("defaults any other non-empty set to NBA", () => {
    expect(leagueForSetName("Base Set")).toBe("NBA")
    expect(leagueForSetName("Cosmic")).toBe("NBA")
  })

  it("returns null for nullish/empty input", () => {
    expect(leagueForSetName(null)).toBeNull()
    expect(leagueForSetName(undefined)).toBeNull()
    expect(leagueForSetName("")).toBeNull()
  })
})

// #219 (2026-10-30): the team label decides first; the set rule is the fallback.
describe("leagueForEdition", () => {
  const WNBA = new Set(["Washington Mystics", "Houston Comets"])
  it("a WNBA team label in a MIXED set is WNBA, where the set rule said NBA", () => {
    expect(leagueForSetName("Fresh Gems")).toBe("NBA")
    expect(leagueForEdition("Fresh Gems", "Washington Mystics", WNBA)).toBe("WNBA")
    expect(leagueForEdition("Level Up", "Houston Comets", WNBA)).toBe("WNBA")
  })
  it("an NBA team in a mixed set stays NBA; a WNBA-only set is WNBA even with no team", () => {
    expect(leagueForEdition("Fresh Gems", "Denver Nuggets", WNBA)).toBe("NBA")
    expect(leagueForEdition("Rise With Us", null, WNBA)).toBe("WNBA")
    expect(leagueForEdition("WNBA Archive Set 2008", "Sacramento Monarchs", WNBA)).toBe("WNBA")
  })
  it("an EMPTY label set (a failed registry read) is the set rule, never a guess", () => {
    expect(leagueForEdition("Fresh Gems", "Washington Mystics", new Set())).toBe("NBA")
    expect(leagueForEdition(null, "Washington Mystics", new Set())).toBeNull()
  })
})
