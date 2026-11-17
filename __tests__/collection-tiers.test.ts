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
  // UFC Strike re-pinned 2026-10-18 to the CHAIN's TIER trait (UFC_NFT set
  // metadata, public.ufc_chain_set_metadata). The old pin (CONTENDER / CHALLENGER /
  // FANDOM / CHAMPION) matched the DB, but the DB tiers were fabricated by RPC from
  // edition size — "live" must mean the chain, not our own invented copy.
  ufc: ["COMMON", "UNCOMMON", "RARE", "EPIC", "CHAMPION", "ULTIMATE", "FANDOM"],
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

  it("UFC uses the chain's own vocabulary — EPIC included, no fabricated tier", () => {
    const ufc = collectionTiers("ufc")
    expect(ufc).toEqual(["COMMON", "UNCOMMON", "RARE", "EPIC", "CHAMPION", "ULTIMATE", "FANDOM"])
    // The RPC-invented labels (edition size <=25,000 / <=999) must never return as chips.
    for (const fabricated of ["CONTENDER", "CHALLENGER"]) expect(ufc).not.toContain(fabricated)
    // UFC has no LEGENDARY on chain — a LEGENDARY chip would be dead.
    expect(ufc).not.toContain("LEGENDARY")
  })

  it("Pinnacle has no tiers — its scarcity bands are variants", () => {
    expect(collectionTiers("disney-pinnacle")).toEqual([])
    expect(collectionTiers("pinnacle")).toEqual([])
    expect(sniperTierTabs("disney-pinnacle")).toEqual(["all"])
  })

  it("sniper tabs are 'all' + the collection's own tiers, lowercased", () => {
    expect(sniperTierTabs("ufc")).toEqual(["all", "common", "uncommon", "rare", "epic", "champion", "ultimate", "fandom"])
    expect(sniperTierTabs("nfl-all-day")).toEqual([
      "all", "common", "uncommon", "rare", "legendary", "ultimate",
    ])
  })

  it("an unknown slug falls back to the UNION, never to one collection's list", () => {
    const fallback = collectionTiers("some-future-collection")
    for (const t of ["COMMON", "EPIC", "CHAMPION", "ULTIMATE"]) expect(fallback).toContain(t)
    // The fabricated legacy UFC labels are not in the union either.
    for (const t of ["CONTENDER", "CHALLENGER"]) expect(fallback).not.toContain(t)
  })

  it("a prototype-key slug falls back to the UNION, not a prototype member (no crash)", () => {
    // Bare bracket access would resolve these to Object.prototype members
    // (functions), which are truthy and survive `?? ALL_TIERS`, then throw when
    // sniperTierTabs maps over the non-array. Each must resolve to the union.
    // The union isn't exported, so compare identity against an unknown-slug hit
    // (both return the same ALL_TIERS reference).
    const union = collectionTiers("zzz-not-a-real-collection")
    for (const key of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
      expect(collectionTiers(key), key).toBe(union)
      // sniperTierTabs must return a real string[] ("all" + lowercased union),
      // never throw.
      expect(() => sniperTierTabs(key), key).not.toThrow()
      const tabs = sniperTierTabs(key)
      expect(Array.isArray(tabs), key).toBe(true)
      expect(tabs[0]).toBe("all")
    }
  })

  it("every mapped slug is uppercase and duplicate-free", () => {
    for (const [slug, tiers] of Object.entries(COLLECTION_TIERS)) {
      expect(tiers, slug).toEqual(tiers.map((t) => t.toUpperCase()))
      expect(new Set(tiers).size, slug).toBe(tiers.length)
    }
  })
})
