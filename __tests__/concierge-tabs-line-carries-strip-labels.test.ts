import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { getCollection, PAGE_LABELS, tabBarPages, TAB_BAR_HIDDEN_PAGES } from "@/lib/collections"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-11-07: asked to "list the tabs on the Top Shot page", the concierge
// answered "Collection: /nba-top-shot/collection … Pack Sniper … Hot Floors …
// Challenges" — the strip shows BINDER, and those three are folded under
// Market's sub-toggle, not tabs. The prompt's tabs line was bare paths, so the
// model named tabs from URL segments. It now carries the strip's own label per
// page and marks a folded page. Pinned at the source (the route cannot be
// imported in a unit test) AND by evaluating the expression it must use.

const ROUTE = stripComments(readFileSync(join(__dirname, "..", "app", "api", "support-chat", "route.ts"), "utf8"))

describe("the concierge's per-collection tabs line", () => {
  const start = ROUTE.indexOf("const tabsFor = ")
  const end = ROUTE.indexOf("const publishedTabsLine")
  const body = ROUTE.slice(start, end)

  it("exists and feeds publishedTabsLine", () => {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(ROUTE.slice(end, end + 200)).toContain("tabsFor(c)")
  })
  it("labels each page with the strip's PAGE_LABELS, not the URL segment", () => {
    expect(body).toContain("PAGE_LABELS[p]")
  })
  it("marks a page the strip folds (TAB_BAR_HIDDEN_PAGES) as not a tab", () => {
    expect(body).toContain("tabBarPages(c)")
    expect(body).toMatch(/not a tab in the strip/)
  })
  it("the premise still holds: Top Shot folds at least one registry page and labels collection 'Binder'", () => {
    const ts = getCollection("nba-top-shot")!
    expect(PAGE_LABELS.collection).toBe("Binder")
    const folded = ts.pages.filter((p) => TAB_BAR_HIDDEN_PAGES.has(p))
    expect(folded.length).toBeGreaterThan(0)
    expect(tabBarPages(ts)).not.toContain(folded[0])
  })
})
