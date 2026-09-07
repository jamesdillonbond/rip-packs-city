// UFC has no sniper tab, and every surface that used to offer one agrees.
//
// WHY (Trevor, 2026-09-06): "we should just get rid of the sniper section for
// ufc since there is no market currently." UFC Strike's Flow market last traded
// 2026-05-13 (lib/market-closed.ts), so a deal-finder there could only rank the
// final discounts before close — a tool nobody can act on, which the read-only
// product rule already forbids offering.
//
// ⭐ THE REGISTRY IS THE SWITCH. `pages` in lib/collections.ts drives the tab
// bar, the overview Tools card and Sniper panel, the mobile bottom bar, the
// sitemap URL and the folded-tab canonical. This file pins that the switch is
// OFF and that each derived surface actually followed — because "it's derived"
// is a claim about code someone can break, not a guarantee.
//
// ⚠ EVERY ASSERTION IS DERIVED FROM THE REGISTRY, never from the string "ufc"
// plus a hardcoded expectation — except the one that has to be literal (that
// UFC specifically lacks it), which is the product decision itself.

import { describe, it, expect } from "vitest"
import {
  collectionHasPage,
  getCollection,
  publishedCollections,
  tabBarPages,
} from "@/lib/collections"
import { PUBLIC_TAB_PAGES } from "@/lib/seo"

describe("UFC's sniper tab is retired", () => {
  it("the registry does not list it — this is the product decision", () => {
    const ufc = getCollection("ufc")
    expect(ufc, "ufc missing from the registry").toBeTruthy()
    expect(ufc!.published, "this pin is meaningless if UFC is unpublished").toBe(true)
    expect(ufc!.pages).not.toContain("sniper")
    expect(collectionHasPage("ufc", "sniper" as never)).toBe(false)
  })

  it("UFC still has the tabs it kept — the removal was surgical", () => {
    // Without this, deleting the whole `pages` array would satisfy the case above.
    for (const page of ["overview", "collection", "sets", "analytics"]) {
      expect(collectionHasPage("ufc", page as never), page).toBe(true)
    }
  })

  it("the tab bar drops it", () => {
    const ufc = getCollection("ufc")!
    expect(tabBarPages(ufc)).not.toContain("sniper")
    // Non-vacuous: the bar must still render something.
    expect(tabBarPages(ufc).length).toBeGreaterThan(1)
  })

  it("the sitemap cannot advertise it — the tab set intersected with the public tabs", () => {
    const ufc = getCollection("ufc")!
    const advertised = ufc.pages.filter((p) => PUBLIC_TAB_PAGES.includes(p))
    expect(advertised).not.toContain("sniper")
    expect(advertised.length).toBeGreaterThan(0)
  })

  it("NO-CHANGE CONTROL — every other published collection keeps its sniper", () => {
    // The failure this catches is a fix applied one level too high: dropping
    // "sniper" from a shared list rather than from UFC's own row would satisfy
    // every case above while silently retiring four working tools.
    const others = publishedCollections().filter((c) => c.id !== "ufc" && c.pages.length > 1)
    expect(others.length, "expected other multi-tab published collections").toBeGreaterThan(2)
    for (const c of others) {
      expect(collectionHasPage(c.id, "sniper" as never), `${c.id} lost its sniper`).toBe(true)
    }
  })
})

describe("/ufc/sniper redirects rather than serving a shell", () => {
  it("the edge redirect names it", async () => {
    const { RETIRED_COLLECTION_TABS } = await import("@/proxy")
    expect(RETIRED_COLLECTION_TABS.has("ufc/sniper")).toBe(true)
  })

  it("every entry is a tab its collection genuinely lacks (the set cannot drift onto a LIVE tab)", async () => {
    // The one-way derived check. It cannot demand the set be complete — the
    // wider soft-404 class is deliberately out of scope and filed — but it CAN
    // guarantee no entry ever redirects a tab a collection actually ships,
    // which is the way this list could do real damage.
    const { RETIRED_COLLECTION_TABS } = await import("@/proxy")
    expect(RETIRED_COLLECTION_TABS.size).toBeGreaterThan(0)
    for (const pair of RETIRED_COLLECTION_TABS) {
      const [slug, tab] = pair.split("/")
      expect(getCollection(slug!), `${pair}: unknown collection`).toBeTruthy()
      expect(collectionHasPage(slug!, tab as never), `${pair} IS a live tab — redirecting it breaks the product`).toBe(false)
    }
  })

  it("a redirect, not a soft-404: the anon-public + indexed case needs a status line", async () => {
    // Recorded as the reason this is in proxy.ts and not FeatureTabGate. If
    // someone later swaps it for the gate component, /ufc/sniper goes back to
    // answering 200 with a not-found body on a URL Google has indexed.
    const { isPublicPath } = await import("@/proxy")
    expect(isPublicPath("/ufc/sniper", "GET"), "if this is false the redirect rationale changed").toBe(true)
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
