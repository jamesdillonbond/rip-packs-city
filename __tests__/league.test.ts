import { describe, it, expect } from "vitest"
import { leagueForSetName, WNBA_ONLY_SETS } from "@/lib/league"

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
