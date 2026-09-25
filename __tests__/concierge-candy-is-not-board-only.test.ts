// 2026-09-25 — asked "What is a Shohei Ohtani worth?" on Candy MLB, the concierge
// said "Candy MLB is a board-only surface on RPC (the /insights/candy-mlb board)"
// and sent the user to "Candy Digital" for live listings. Both were stale prompt
// text: Candy MLB is a PUBLISHED collection with full tabs, and its secondary
// market is Magic Eden (Candy Digital is the issuer). Only Panini is board-only.

import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { publishedCollections } from "@/lib/collections"

const ROOT = join(__dirname, "..")
const ROUTE = readFileSync(join(ROOT, "app", "api", "support-chat", "route.ts"), "utf8")

describe("the concierge prompt does not call a published collection board-only", () => {
  it("every 'board-only' claim is about Panini, never Candy", () => {
    const windows: string[] = []
    let i = ROUTE.indexOf("board-only")
    while (i >= 0) {
      // The CLAUSE the claim sits in: back to the nearest sentence / clause break.
      const before = ROUTE.slice(Math.max(0, i - 160), i)
      const cut = Math.max(before.lastIndexOf(". "), before.lastIndexOf("; "), before.lastIndexOf(", '"))
      windows.push(before.slice(cut + 1) + ROUTE.slice(i, i + 20))
      i = ROUTE.indexOf("board-only", i + 1)
    }
    expect(windows.length, "no board-only claim left to check").toBeGreaterThan(0)
    for (const w of windows) {
      expect(w, w).toContain("Panini")
      expect(w, w).not.toMatch(/candy/i)
    }
  })

  it("Candy MLB is published (the premise of this test)", () => {
    expect(publishedCollections().some((c) => c.id === "candy-mlb")).toBe(true)
  })

  it("every Candy tab path the prompt names is a real route", () => {
    const m = /Candy MLB, on Solana, ALSO has full collection tabs at ([^—]+)—/.exec(ROUTE)
    expect(m, "Candy tab clause missing").not.toBeNull()
    const tabs = [...m![1].matchAll(/\/(?:candy-mlb\/)?([a-z-]+)/g)].map((x) => x[1]).filter((t) => t !== "candy-mlb")
    expect(tabs.length).toBeGreaterThanOrEqual(5)
    for (const t of tabs) {
      const dir = join(ROOT, "app", "(collections)", "[collection]", t)
      expect(existsSync(join(dir, "page.tsx")), `/candy-mlb/${t} has no page`).toBe(true)
    }
  })

  it("names Magic Eden as Candy's secondary market", () => {
    expect(ROUTE).toMatch(/Candy[^.]*secondary market is Magic Eden/)
  })
})
