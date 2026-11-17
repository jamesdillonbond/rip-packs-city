import { describe, it, expect } from "vitest"
import { gatedTabRobots, pageMetadata, PUBLIC_TAB_PAGES, FOLDED_TAB_PARENT } from "@/lib/seo"
import { publishedCollections, collectionHasPage, type CollectionPage } from "@/lib/collections"

// ─────────────────────────────────────────────────────────────────────────────
// A tab URL for a collection that does not ship that tab renders a 200 "isn't
// available" shell (components/collection/FeatureTabGate.tsx, packs/layout.tsx)
// — a soft-404. The edge 307s only RETIRED_COLLECTION_TABS; the other ~19 shells
// were self-canonical + `index, follow` (review §3 E7). This pins: gated case →
// `robots: {index:false, follow:true}`; shipped case → NO robots override (the
// sitemap'd tabs must stay indexable); unknown collection → untouched (that is
// unknownCollectionMetadata's job). Derived over the registry × the tab set, so
// a new collection or tab is covered without editing this file.
// ─────────────────────────────────────────────────────────────────────────────

const TABS = [...PUBLIC_TAB_PAGES, ...Object.keys(FOLDED_TAB_PARENT)].filter((t) => t !== "overview")
const cases = publishedCollections().flatMap((c) => TABS.map((tab) => [c.id, tab] as const))

describe("gatedTabRobots — derived over every published collection × every tab", () => {
  it("the population has BOTH gated and shipped cells (not vacuous)", () => {
    const gated = cases.filter(([id, tab]) => !collectionHasPage(id, tab as CollectionPage))
    const shipped = cases.filter(([id, tab]) => collectionHasPage(id, tab as CollectionPage))
    expect(gated.length).toBeGreaterThan(5)
    expect(shipped.length).toBeGreaterThan(5)
    // Two shells the review named by URL.
    expect(collectionHasPage("ufc", "market")).toBe(false)
    // disney-pinnacle shipped hot-floors 2026-10-26; laliga-golazos still lacks it.
    expect(collectionHasPage("laliga-golazos", "hot-floors")).toBe(false)
  })

  it.each(cases)("%s/%s", (id, tab) => {
    const robots = gatedTabRobots(tab, id)
    if (collectionHasPage(id, tab as CollectionPage)) {
      expect(robots, `${id}/${tab} ships — it must stay indexable`).toEqual({})
    } else {
      expect(robots).toEqual({ robots: { index: false, follow: true } })
    }
  })

  it("an unknown collection is left to unknownCollectionMetadata (returns {})", () => {
    expect(gatedTabRobots("market", "totally-bogus-slug")).toEqual({})
  })
})

describe("the metadata the layouts actually export carries it", () => {
  it("pageMetadata: /ufc/market is noindex,follow and keeps its canonical; /nba-top-shot/market is not touched", () => {
    const gated = pageMetadata("market", "UFC Strike", "ufc")
    expect(gated.robots).toEqual({ index: false, follow: true })
    expect(gated.alternates?.canonical).toBe("https://www.rippackscity.com/ufc/market")
    const live = pageMetadata("market", "NBA Top Shot", "nba-top-shot")
    expect(live.robots).toBeUndefined()
  })

  it("pageMetadata still returns {} for a page with no PAGE_META (control)", () => {
    expect(pageMetadata("not-a-page", "X", "ufc")).toEqual({})
  })

  it.each(["hot-floors", "challenges", "pack-sniper"])("folded layout %s: noindex only where the collection lacks the tab", async (tab) => {
    const mod = await import(`@/app/(collections)/[collection]/${tab}/layout`)
    const meta = async (collection: string) => mod.generateMetadata({ params: Promise.resolve({ collection }) })
    // UFC ships none of the folded tabs; Top Shot ships all three.
    const ufc = await meta("ufc")
    expect(ufc.robots).toEqual({ index: false, follow: true })
    expect(ufc.alternates?.canonical).toMatch(/^https:\/\/www\.rippackscity\.com\/ufc\//)
    const ts = await meta("nba-top-shot")
    expect(ts.robots).toBeUndefined()
  })

  it.each(["market", "sets"])("[collection]/%s/layout.tsx: noindex exactly where the registry says the tab is absent", async (tab) => {
    const mod = await import(`@/app/(collections)/[collection]/${tab}/layout`)
    let gatedSeen = 0
    for (const c of publishedCollections()) {
      const m = await mod.generateMetadata({ params: Promise.resolve({ collection: c.id }) })
      if (collectionHasPage(c.id, tab as CollectionPage)) expect(m.robots, `${c.id}/${tab} ships`).toBeUndefined()
      else {
        gatedSeen++
        expect(m.robots, `${c.id}/${tab} is a gate shell`).toEqual({ index: false, follow: true })
      }
    }
    // `market` has a gated cell today (UFC); `sets` has none — every published
    // collection ships it — so only the shipped arm is exercised there. Said
    // explicitly so a future reader does not mistake this for coverage of both.
    if (tab === "market") expect(gatedSeen).toBeGreaterThan(0)
  })
})
