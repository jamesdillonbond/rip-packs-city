import { describe, it, expect } from "vitest"
import {
  tabBarPages,
  TAB_BAR_HIDDEN_PAGES,
  getCollection,
  type Collection,
  type CollectionPage,
} from "@/lib/collections"

// tabBarPages() (2026-07-18 IA reorg): the folded pages (pack-sniper /
// hot-floors / challenges) stay in pages[] as a superset so every gate +
// capability check keeps working, but are hidden from the top tab bar — reached
// via the Sniper Packs sub-toggle + the Play hub instead.
// 2026-11-07: `packs` is a top-level tab again — Packs is one of the IA's five
// pillars with its own bottom-bar tab landing on /<c>/packs, and that page's
// strip showed no active tab while packs was folded.

describe("tabBarPages", () => {
  it("hides exactly the folded pages from the top bar", () => {
    expect([...TAB_BAR_HIDDEN_PAGES].sort()).toEqual(
      ["challenges", "hot-floors", "pack-sniper"],
    )
  })

  it("the Packs page is a top-level tab, so the bottom bar's PACKS lands on a lit tab (2026-11-07)", () => {
    const ts = getCollection("nba-top-shot")!
    expect(tabBarPages(ts)).toContain("packs")
    expect(TAB_BAR_HIDDEN_PAGES.has("packs")).toBe(false)
  })

  it("collapses Top Shot to the launch tab set (folded pages dropped, play kept, order preserved)", () => {
    const ts = getCollection("nba-top-shot")!
    expect(tabBarPages(ts)).toEqual([
      "overview",
      "collection",
      "market",
      "packs",
      "sniper",
      "play",
      "sets",
      "analytics",
    ])
  })

  it("keeps every folded page in the registry pages[] (superset — gates still resolve)", () => {
    const ts = getCollection("nba-top-shot")!
    for (const p of TAB_BAR_HIDDEN_PAGES) {
      expect(ts.pages).toContain(p)
      expect(tabBarPages(ts)).not.toContain(p)
    }
  })

  it("returns pages unchanged for a collection with no folded pages", () => {
    const c: Collection = {
      id: "x",
      label: "X",
      shortLabel: "X",
      sport: "X",
      chain: "flow",
      partner: "X",
      accent: "#000",
      icon: "x",
      pages: ["overview", "collection", "market", "sniper", "analytics"] as CollectionPage[],
      published: true,
    }
    expect(tabBarPages(c)).toEqual(["overview", "collection", "market", "sniper", "analytics"])
  })

  it("does not add play to collections that don't list it (TS-only feature)", () => {
    const allday = getCollection("nfl-all-day")!
    expect(tabBarPages(allday)).not.toContain("play")
    const pinnacle = getCollection("disney-pinnacle")!
    expect(tabBarPages(pinnacle)).not.toContain("play")
  })
})
