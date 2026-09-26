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
  // ⭐ REWRITTEN 2026-09-25 (was: "every 'board-only' claim is about Panini").
  // Panini PUBLISHED that day, so the one legitimate board-only claim became
  // false too. The property was always "never call a PUBLISHED collection
  // board-only"; it is now asserted for every published collection, and it is
  // satisfiable at a population of zero claims (there are none today).
  it("no 'board-only' claim names a PUBLISHED collection", () => {
    const names = publishedCollections().flatMap((c) => [c.label, c.shortLabel ?? c.label, c.id])
    const windows: string[] = []
    const src = stripComments(ROUTE)
    let i = src.indexOf("board-only")
    while (i >= 0) {
      const before = src.slice(Math.max(0, i - 160), i)
      const cut = Math.max(before.lastIndexOf(". "), before.lastIndexOf("; "), before.lastIndexOf(", '"))
      windows.push(before.slice(cut + 1) + src.slice(i, i + 20))
      i = src.indexOf("board-only", i + 1)
    }
    for (const w of windows) {
      for (const n of names) expect(w.toLowerCase(), w).not.toContain(n.toLowerCase())
    }
    // Planted: the exact pre-publish sentence must be caught by the same scan.
    const planted = "Panini is the one board-only surface (/insights/panini-squeeze)"
    expect(names.some((n) => planted.toLowerCase().includes(n.toLowerCase()))).toBe(true)
  })

  it("Panini's tabs are derived from the registry, never hand-kept", () => {
    expect(ROUTE).toContain('getCollection("panini-blockchain")?.pages')
    expect(ROUTE).toContain("${PANINI_TAB_PATHS}")
    for (const m of stripComments(ROUTE).matchAll(/\/panini-blockchain\/([a-z-]+)/g)) {
      expect(["overview", "market"], `/panini-blockchain/${m[1]} is not a Panini tab`).toContain(m[1])
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
