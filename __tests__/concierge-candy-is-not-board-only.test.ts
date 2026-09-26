// 2026-09-25 — asked "What is a Shohei Ohtani worth?" on Candy MLB, the concierge
// said "Candy MLB is a board-only surface on RPC (the /insights/candy-mlb board)"
// and sent the user to "Candy Digital" for live listings. Both were stale prompt
// text: Candy MLB is a PUBLISHED collection with full tabs, and its secondary
// market is Magic Eden (Candy Digital is the issuer). Only Panini is board-only.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { publishedCollections } from "@/lib/collections"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

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

  // ⭐ REWRITTEN 2026-09-25. This used to check that each named path had a
  // page.tsx SOMEWHERE — and /sniper does exist, for other collections, so a
  // hand-kept list naming /candy-mlb/sniper (a tab Candy does not have; the URL
  // redirects) passed. The property is "only tabs CANDY has", so both Candy tab
  // lists are now derived from the registry and pinned here, and no Candy path
  // outside the registry's pages may appear as a literal.
  it("names only the tabs Candy actually has — derived from the registry, never hand-kept", async () => {
    const { getCollection } = await import("@/lib/collections")
    const pages = getCollection("candy-mlb")?.pages ?? []
    expect(pages.length).toBeGreaterThanOrEqual(5)
    expect(ROUTE).toContain('getCollection("candy-mlb")?.pages')
    expect(ROUTE).toContain("${CANDY_TAB_PATHS}")
    expect(ROUTE).toContain("${candyTabs}")
    // Comments stripped: a comment naming the old dead link is not a claim to a user.
    for (const m of stripComments(ROUTE).matchAll(/\/candy-mlb\/([a-z-]+)/g)) {
      expect(pages as readonly string[], `/candy-mlb/${m[1]} is not a Candy tab`).toContain(m[1])
    }
  })

  it("names Magic Eden as Candy's secondary market", () => {
    expect(ROUTE).toMatch(/Candy[^.]*secondary market is Magic Eden/)
  })
})
