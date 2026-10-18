// __tests__/ufc-chain-tier-vocabulary.test.ts
//
// UFC Strike's tiers are the CHAIN's TIER trait (UFC_NFT.getSetMetadata, stored in
// public.ufc_chain_set_metadata, read 2026-10-18): COMMON, UNCOMMON, RARE, EPIC,
// CHAMPION, ULTIMATE, FANDOM. Before that, RPC FABRICATED "CONTENDER" (edition
// size <= 25,000) and "CHALLENGER" (<= 999) — tiers that do not exist on chain —
// and every UFC surface rendered them. This pins the replacement end to end:
// the filter vocabulary, the new EPIC colour on every surface map, and that an
// unknown tier never renders as an invented one.

import { describe, it, expect } from "vitest"
import { collectionTiers } from "@/lib/collection-tiers"
import { TIER_COLORS, tierColor as marketTierColor } from "@/lib/market-format"
import { TIER_STRIPE } from "@/lib/sets/display"
import { tierColor as sniperTierColor } from "@/lib/sniper/helpers"
import { tierColorVar } from "@/lib/moment-detail-format"
import { normalizeTier, tierRank } from "@/lib/tier-order"
import { TROPHY_TIER_RANK } from "@/lib/trophy-comparator"

describe("UFC Strike chain tier vocabulary", () => {
  it("the UFC filter list is the chain ladder: EPIC in, the fabricated labels out", () => {
    const ufc = collectionTiers("ufc")
    expect(ufc).toContain("EPIC")
    expect(ufc).not.toContain("CONTENDER")
    expect(ufc).not.toContain("CHALLENGER")
  })

  it("EPIC has a real colour on every tier map (no silent muted fallback)", () => {
    expect(TIER_COLORS.EPIC).toBe("var(--tier-epic)")
    expect(marketTierColor("epic")).toBe("var(--tier-epic)")
    expect(TIER_STRIPE.EPIC).toBe("var(--tier-epic)")
    expect(sniperTierColor("EPIC")).toBe("var(--tier-epic)")
    expect(tierColorVar("EPIC")).toMatch(/--tier-epic/)
  })

  it("EPIC is canonical and ranks on the chain ladder RARE < EPIC < CHAMPION < ULTIMATE", () => {
    expect(normalizeTier("Epic")).toBe("EPIC")
    expect(tierRank("RARE")!).toBeLessThan(tierRank("EPIC")!)
    expect(tierRank("EPIC")!).toBeLessThan(tierRank("CHAMPION")!)
    expect(tierRank("CHAMPION")!).toBeLessThan(tierRank("ULTIMATE")!)
    expect(TROPHY_TIER_RANK.EPIC).toBeGreaterThan(TROPHY_TIER_RANK.RARE)
    expect(TROPHY_TIER_RANK.CHAMPION).toBeGreaterThan(TROPHY_TIER_RANK.EPIC)
  })

  it("a NULL tier (UFC catchphrase moments carry none on chain) renders muted, never as a tier", () => {
    expect(marketTierColor(null)).toBe("var(--rpc-text-muted)")
    expect(tierColorVar(null)).toBe("var(--rpc-text-muted)")
  })
})
