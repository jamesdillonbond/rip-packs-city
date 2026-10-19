import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { collectionHasWalletPackHistory } from "@/lib/collections"

// 2026-10-18: the Collection tab's Packs sub-tab was gated by a literal
// "Top Shot || All Day", which hid it for LaLiga Golazos (opens attributed to
// 23,325 collector wallets). It now reads one registry capability.
describe("Collection tab Packs sub-tab — collectionHasWalletPackHistory", () => {
  it("covers the collections whose pack history is attributed to collectors", () => {
    for (const id of ["nba-top-shot", "nfl-all-day", "laliga-golazos"]) {
      expect(collectionHasWalletPackHistory(id), id).toBe(true)
    }
  })

  it("leaves Pinnacle out (13 % of its opens sit on the custodian, so a tab would read partial as complete)", () => {
    expect(collectionHasWalletPackHistory("disney-pinnacle")).toBe(false)
    // Panini and Candy list a "packs" page but have no wallet pack data.
    expect(collectionHasWalletPackHistory("panini-blockchain")).toBe(false)
    expect(collectionHasWalletPackHistory("candy-mlb")).toBe(false)
  })

  it("the tab reads the capability, not a literal slug list", () => {
    const src = readFileSync("app/(collections)/[collection]/collection/CollectionTabClient.tsx", "utf8")
    const line = src.split("\n").find((l) => l.includes("const hasPacks ="))
    expect(line).toContain("collectionHasWalletPackHistory(collectionSlug)")
    expect(line).not.toMatch(/collectionSlug === "/)
  })
})
