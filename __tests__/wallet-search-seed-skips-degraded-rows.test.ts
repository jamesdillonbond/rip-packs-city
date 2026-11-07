// 2026-11-07 review: wallet-search's insert-only edition seed wrote DEGRADED rows
// (metadata read failed) as real editions — `85:2918` was named
// "Unknown (error loading) — Dynamic Duos" for six months, and a player named
// "Unknown (error loading)" was created — and turned a missing tier into COMMON.
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { isSeedableRow, seedTier } from "@/lib/wallet-search/seed-edition"

const good = { editionKey: "85:2918", playerName: "Brooklyn Nets", setName: "Dynamic Duos", tier: "RARE" }

describe("isSeedableRow", () => {
  it("seeds a row whose metadata was read", () => {
    expect(isSeedableRow(good)).toBe(true)
  })
  it.each([
    ["the error-loading placeholder", { ...good, playerName: "Unknown (error loading)" }],
    ["the Unknown Player placeholder", { ...good, playerName: "Unknown Player" }],
    ["the Unknown Set placeholder", { ...good, setName: "Unknown Set" }],
    ["no player name", { ...good, playerName: "" }],
    ["no edition key", { ...good, editionKey: null }],
  ])("refuses %s", (_label, row) => {
    expect(isSeedableRow(row)).toBe(false)
  })
})

describe("seedTier", () => {
  it("maps known tier strings", () => {
    expect(seedTier("MOMENT_TIER_RARE")).toBe("RARE")
    expect(seedTier("Common")).toBe("COMMON")
    expect(seedTier("UNCOMMON")).toBe("UNCOMMON")
    expect(seedTier("Legendary")).toBe("LEGENDARY")
  })
  it("a missing or unrecognised tier is NULL, never a fabricated COMMON", () => {
    expect(seedTier(undefined)).toBeNull()
    expect(seedTier("")).toBeNull()
    expect(seedTier("MOMENT_TIER_UNKNOWN")).toBeNull()
  })
})

describe("wallet-search seed", () => {
  it("gates every row through isSeedableRow and seedTier, with no COMMON default", () => {
    const src = stripComments(readFileSync("app/api/wallet-search/route.ts", "utf8"))
    const body = src.slice(src.indexOf("async function seedEditionsToSupabase"))
    const fn = body.slice(0, body.indexOf("\n}\n"))
    expect(fn).toContain("if (!isSeedableRow(row)) continue")
    expect(fn).toContain("seedTier(row.tier)")
    expect(fn).not.toMatch(/\?\?\s*"COMMON"/)
    expect(fn).not.toMatch(/:\s*"COMMON"/)
  })
})
