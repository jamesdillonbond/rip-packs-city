import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import {
  anyTier,
  BIG_SPENDER,
  classifyOwnerKey,
  decide,
  highestTier,
  holdingsWalletKey,
  PACK_HUNTER,
  SERIES_COLLECTOR,
  serialSniperTier,
  TROPHY_CURATOR,
} from "@/supabase/functions/_shared/achievements"

// compute-achievements (2026-10-17). Before this, every count was `count ?? 0`
// with its error unread and a zero meant deleteAchievement — a failed read was a
// DELETE of a collector's badge. These pin the decision logic the edge function
// now imports.

describe("decide — a failed read never deletes", () => {
  it("a failed read SKIPS, leaving the row as it was", () => {
    expect(decide({ ok: false, error: "statement timeout" })).toEqual({ kind: "skip", reason: "statement timeout" })
  })
  it("a successful read with no tier deletes; with a tier upserts", () => {
    expect(decide({ ok: true, tier: null })).toEqual({ kind: "delete" })
    expect(decide({ ok: true, tier: "silver" })).toEqual({ kind: "upsert", tier: "silver" })
  })
})

describe("tier tables", () => {
  it("highestTier takes the top threshold met, null below the first", () => {
    expect(highestTier(PACK_HUNTER, 9)).toBeNull()
    expect(highestTier(PACK_HUNTER, 10)).toBe("bronze")
    expect(highestTier(PACK_HUNTER, 499)).toBe("gold")
    expect(highestTier(PACK_HUNTER, 500)).toBe("platinum")
    expect(highestTier(TROPHY_CURATOR, 6)).toBe("gold")
    expect(highestTier(SERIES_COLLECTOR, 2)).toBeNull()
    expect(highestTier(BIG_SPENDER, 1000)).toBe("silver")
  })
  it("serial_sniper: gold 3+ <=10, silver 1+ <=10, bronze 1+ <=100", () => {
    expect(serialSniperTier(3, 3)).toBe("gold")
    expect(serialSniperTier(1, 5)).toBe("silver")
    expect(serialSniperTier(0, 1)).toBe("bronze")
    expect(serialSniperTier(0, 0)).toBeNull()
  })
  it("single-tier achievements are gold at 1+", () => {
    expect(anyTier(0)).toBeNull()
    expect(anyTier(1)).toBe("gold")
  })
})

describe("owner keys and wallets", () => {
  it("classifies the three owner_key shapes", () => {
    expect(classifyOwnerKey("3f2b6c1e-9a7d-4c2e-8b1f-0a1b2c3d4e5f")).toBe("user_id")
    expect(classifyOwnerKey("0xBD94CADE097E50AC")).toBe("flow_address")
    expect(classifyOwnerKey("juiceshack")).toBe("username")
  })
  it("keys hex wallets lower-case, keeps base58 verbatim, and refuses anything else", () => {
    expect(holdingsWalletKey(" 0xBD94CADE097E50AC ")).toBe("0xbd94cade097e50ac")
    expect(holdingsWalletKey("0x" + "A".repeat(40))).toBe("0x" + "a".repeat(40))
    const sol = "12J1uhKQcBYauomKvXDP2MA6msT3k8wx8oHHhV8gENAK"
    expect(holdingsWalletKey(sol)).toBe(sol)
    // A legacy Top Shot username in wallet_addr: its resolver is dead, so the
    // wallet is unresolvable rather than silently dropped.
    expect(holdingsWalletKey("some_username")).toBeNull()
  })
})

describe("the edge function routes every write through decide()", () => {
  const src = stripComments(readFileSync("supabase/functions/compute-achievements/index.ts", "utf8"))
  it("imports the shared module and never defaults a count to zero", () => {
    expect(src).toMatch(/from '\.\.\/_shared\/achievements\.ts'/)
    expect(src).not.toMatch(/count\s*\?\?\s*0/)
    // profile_achievements writes happen only inside applyAchievement.
    expect(src.match(/from\('profile_achievements'\)\.(delete|upsert)/g)?.length ?? 0).toBe(2)
  })
})
