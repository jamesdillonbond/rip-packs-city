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

// 2026-11-07 (afternoon): asked "where did the trade link go on mobile", the
// concierge answered correctly AND logged a bug — Trade's absence from the bar
// is a registry decision (lib/ia.ts MOBILE_GROUP_IDS), not a defect. The
// prompt now says so, and says the keyboard facts the same day's a11y work
// made true. Both are claims about the code, so they are pinned to it.
import { MOBILE_GROUP_IDS } from "@/lib/ia"
describe("the concierge's navigation facts match the registry and the shipped keyboard contract", () => {
  it("Trade is off the phone bar in the registry, and the prompt says that is by design", () => {
    expect(MOBILE_GROUP_IDS).not.toContain("trade")
    expect(ROUTE).toMatch(/Trade is NOT on the phone bar BY DESIGN/)
    expect(ROUTE).toMatch(/never logged as a bug/)
  })
  it("the keyboard facts it states are the ones the code implements", () => {
    expect(ROUTE).toMatch(/Left\/Right\/Home\/End move between the tabs/)
    const keys = readFileSync(join(__dirname, "..", "lib", "a11y", "tablist-keys.ts"), "utf8")
    for (const k of ["ArrowLeft", "ArrowRight", "Home", "End"]) expect(keys).toContain(k)
    expect(ROUTE).toMatch(/header search is a combobox/)
    expect(readFileSync(join(__dirname, "..", "components", "search", "GlobalSearch.tsx"), "utf8")).toMatch(/role="combobox"/)
    expect(ROUTE).toMatch(/header groups are hover\/focus-revealed lists of plain links/)
    expect(stripComments(readFileSync(join(__dirname, "..", "components", "TopNav.tsx"), "utf8"))).not.toMatch(/role="menu"/)
  })
})
