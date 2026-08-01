// __tests__/collection-tiers.test.ts
//
// Pins lib/collection-tiers against the LIVE editions.tier vocabulary measured
// 2026-08-01. Regression guard for the QA finding that UFC Strike's Sniper tier
// chips were the Top Shot list (common/uncommon/fandom/rare/legendary/ultimate),
// so five of six chips could never match and 515 of 518 editions were
// unfilterable — plus the Market list's two silent drifts (missing UNCOMMON for
// NFL All Day, dead FANDOM for LaLiga Golazos).

import { describe, it, expect } from "vitest"
import { COLLECTION_TIERS, collectionTiers, sniperTierTabs } from "@/lib/collection-tiers"

// The live vocabulary. If a collection genuinely gains a tier on-chain, update
// BOTH this fixture and the map — that is the point of the test.
const LIVE_TIERS: Record<string, string[]> = {
  "nba-top-shot": ["COMMON", "RARE", "LEGENDARY", "FANDOM", "ULTIMATE"],
  "nfl-all-day": ["RARE", "COMMON", "LEGENDARY", "UNCOMMON", "ULTIMATE"],
  "laliga-golazos": ["UNCOMMON", "RARE", "COMMON", "LEGENDARY"],
  ufc: ["CONTENDER", "CHALLENGER", "FANDOM", "CHAMPION"],
}

describe("collection tier vocabulary", () => {
  for (const [slug, live] of Object.entries(LIVE_TIERS)) {
    it(`${slug}: every configured tier EXISTS on-chain (no dead chips)`, () => {
      for (const t of collectionTiers(slug)) expect(live).toContain(t)
    })
    it(`${slug}: every on-chain tier is REACHABLE through the filter`, () => {
      for (const t of live) expect(collectionTiers(slug)).toContain(t)
    })
  }

  it("UFC uses its own vocabulary, never Top Shot's", () => {
    const ufc = collectionTiers("ufc")
    expect(ufc).toEqual(["CONTENDER", "CHALLENGER", "FANDOM", "CHAMPION"])
    // The exact chips that were dead before the fix.
    for (const wrong of ["COMMON", "UNCOMMON", "RARE", "LEGENDARY", "ULTIMATE"]) {
      expect(ufc).not.toContain(wrong)
    }
  })

  it("Pinnacle has no tiers — its scarcity bands are variants", () => {
    expect(collectionTiers("disney-pinnacle")).toEqual([])
    expect(collectionTiers("pinnacle")).toEqual([])
    expect(sniperTierTabs("disney-pinnacle")).toEqual(["all"])
  })

  it("sniper tabs are 'all' + the collection's own tiers, lowercased", () => {
    expect(sniperTierTabs("ufc")).toEqual(["all", "contender", "challenger", "fandom", "champion"])
    expect(sniperTierTabs("nfl-all-day")).toEqual([
      "all", "common", "uncommon", "rare", "legendary", "ultimate",
    ])
  })

  it("an unknown slug falls back to the UNION, never to one collection's list", () => {
    const fallback = collectionTiers("some-future-collection")
    for (const t of ["COMMON", "CONTENDER", "CHAMPION", "ULTIMATE"]) expect(fallback).toContain(t)
  })

  it("every mapped slug is uppercase and duplicate-free", () => {
    for (const [slug, tiers] of Object.entries(COLLECTION_TIERS)) {
      expect(tiers, slug).toEqual(tiers.map((t) => t.toUpperCase()))
      expect(new Set(tiers).size, slug).toBe(tiers.length)
    }
  })
})
