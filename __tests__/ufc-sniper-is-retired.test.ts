// UFC's sniper tab — RETIRED 2026-09-06, BACK 2026-11-26 (file name kept for history; every pin inverted).
//
// 2026-09-06 (Trevor): "get rid of the sniper section for ufc since there is no market currently" — the
// Flow market last traded 2026-05-13. 2026-11-26 (Trevor: "specific listings in sniper … a Flow or Aptos
// tag"): UFC trades on Aptos (Rarible) and RPC indexes those asks (lib/sniper/ufc-aptos.ts), so the tab
// is back as a board of live Aptos asks, each tagged Aptos.
//
// ⭐ THE REGISTRY IS STILL THE SWITCH (lib/collections.ts `pages`): tab bar, overview Tools card and
// Sniper panel, mobile bottom bar, sitemap URL, folded-tab canonical, and the edge redirect set all
// derive from it. These pins assert each derived surface followed it back.

import { describe, it, expect } from "vitest"
import {
  collectionHasPage,
  getCollection,
  publishedCollections,
  tabBarPages,
} from "@/lib/collections"
import { PUBLIC_TAB_PAGES } from "@/lib/seo"

describe("UFC's sniper tab is back (Aptos asks, 2026-11-26 — inverted from 'retired')", () => {
  it("the registry lists it — this is the product decision", () => {
    const ufc = getCollection("ufc")
    expect(ufc, "ufc missing from the registry").toBeTruthy()
    expect(ufc!.published, "this pin is meaningless if UFC is unpublished").toBe(true)
    expect(ufc!.pages).toContain("sniper")
    expect(collectionHasPage("ufc", "sniper" as never)).toBe(true)
  })

  it("UFC keeps the tabs it had — the return was surgical", () => {
    for (const page of ["overview", "collection", "sets", "analytics"]) {
      expect(collectionHasPage("ufc", page as never), page).toBe(true)
    }
  })

  it("the tab bar shows it", () => {
    expect(tabBarPages(getCollection("ufc")!)).toContain("sniper")
  })

  it("the sitemap advertises it — the tab set intersected with the public tabs", () => {
    const ufc = getCollection("ufc")!
    expect(ufc.pages.filter((p) => PUBLIC_TAB_PAGES.includes(p))).toContain("sniper")
  })

  it("NO-CHANGE CONTROL — the other snipers are untouched", () => {
    // Population = collections that genuinely ship a sniper (see the 09-12 note in git history:
    // a "multi-tab" proxy reddened main when Candy gained a Market tab).
    const withSniper = publishedCollections().filter((c) => collectionHasPage(c.id, "sniper" as never))
    expect(withSniper.map((c) => c.id)).toContain("ufc")
    expect(withSniper.length, "the sniper set collapsed").toBeGreaterThanOrEqual(5)
  })
})

describe("/ufc/sniper serves the page again", () => {
  it("the edge no longer redirects it", async () => {
    const { RETIRED_COLLECTION_TABS } = await import("@/proxy")
    expect(RETIRED_COLLECTION_TABS.has("ufc/sniper")).toBe(false)
  })

  it("every entry is a tab its collection genuinely lacks (the set cannot drift onto a LIVE tab)", async () => {
    const { RETIRED_COLLECTION_TABS } = await import("@/proxy")
    expect(RETIRED_COLLECTION_TABS.size).toBeGreaterThan(0)
    for (const pair of RETIRED_COLLECTION_TABS) {
      const [slug, tab] = pair.split("/")
      expect(getCollection(slug!), `${pair}: unknown collection`).toBeTruthy()
      expect(collectionHasPage(slug!, tab as never), `${pair} IS a live tab — redirecting it breaks the product`).toBe(false)
    }
  })

  it("it is anon-public", async () => {
    const { isPublicPath } = await import("@/proxy")
    expect(isPublicPath("/ufc/sniper", "GET")).toBe(true)
  })
})

describe("the surfaces that linked to it are gated by the registry, not by a literal", () => {
  const read = async (p: string) => (await import("node:fs")).readFileSync(p, "utf8")

  it("the collection profile page gates its sniper section and filters its Tools grid", async () => {
    const src = await read("app/(collections)/[collection]/profile/[username]/CollectionProfileClient.tsx")
    expect(src.length).toBeGreaterThan(1000)
    expect(src).toContain('collectionHasPage(collection, "sniper")')
    // The Tools grid must filter, not hardcode four links. This also fixed a
    // PRE-EXISTING broken /ufc/packs link found while enumerating the callers.
    expect(src).toContain("collectionHasPage(collection, link.page as CollectionPage)")
  })

  it("the overview gates its Sniper panel", async () => {
    const src = await read("app/(collections)/[collection]/overview/CollectionOverviewClient.tsx")
    expect(src).toContain('enabledPages.has("sniper" as never)')
    expect(src).toContain("{hasSniperTab && (")
  })

  it("the missing-tab shell does not point readers at another tab", async () => {
    // It used to read "Use the Overview and Sniper tabs for live market state
    // and deals" — wrong when the missing tab IS the sniper, and a live-market
    // claim on a collection whose market has closed.
    const src = await read("components/collection/FeatureTabGate.tsx")
    expect(src).not.toMatch(/Use the Overview and Sniper tabs/)
    expect(src).not.toMatch(/live market state/)
  })
})
