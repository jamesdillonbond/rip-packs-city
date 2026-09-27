import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it, expect } from "vitest"
import {
  COLLECTION_UUID_BY_SLUG,
  SLUG_TO_DB_SLUG,
  publishedCollections,
  COLLECTIONS,
} from "@/lib/collections"
import {
  getCollectionByUrlSlug,
  getCollectionByUuid,
  getCollectionByDbSlug,
  listEntityPageCollections,
} from "@/lib/collection-slug"

// Cross-module drift guard. lib/collection-slug.ts is a SEPARATE facade with its
// own hardcoded RECORDS table (id / dbSlug / urlSlug) used by every entity detail
// page (edition / set / player / team / series). Nothing forces it to agree with
// the canonical registry in lib/collections.ts, so an edit to one — a re-slugged
// collection, a corrected UUID, a new publish — can silently desync the two and
// break entity-page routing while the collections.ts unit tests stay green.
// These assertions fail the moment the two sources disagree.

// The ENTITY-PAGE collections: published collections whose edition / player /
// set / team pages exist.
//
// ⛔ 2026-09-19 — CANDY MLB MOVED IN, AND THE GUARD THAT KEPT IT OUT WAS THE
//    REASON THE DEFECT SHIPPED. What stood here before said Candy was "THIN —
//    overview only, no entity corpus ... the entity pages are Flow-shaped", and
//    enforced it with an ENTITY_CORPUS_PAGES list of nine page names.
//    `market` was not one of the nine. So when Candy gained a Market tab on
//    2026-09-12, this guard stayed green — while MarketClient linked every row
//    it rendered to /<collection>/edition/<editionKey>, /player, /team and
//    /set, none of which this facade would route.
//
//    MEASURED ON THE LIVE SITE 2026-09-19, before the fix:
//      /candy-mlb/market                          → 200
//      /candy-mlb/edition/mike-trout-pink         → 404
//      /candy-mlb/set/2026-mlb-base-series-icons  → 404
//    and ONE render of that market page emitted 54 edition links, 10 team
//    links, 10 player links and a set link — every one of them dead.
//
//    The second half of the premise was false too: the entity pages read
//    collection-generic RPCs. get_edition_detail / get_player_detail /
//    get_set_detail / get_team_detail were each called live against the Candy
//    UUID and each returned a populated row before the facade was touched.
//
// ⭐ THE LESSON IS IN THE SHAPE, NOT THE ENTRY. A guard that enumerates the
//    pages which MAY NOT appear is satisfied by any page nobody thought to
//    enumerate. The assertion below is therefore INVERTED: it names the pages
//    that DO emit entity links, and requires any published collection carrying
//    one to be IN the facade. A new tab that links to /edition/... and is not
//    listed in ENTITY_LINKING_PAGES will still escape — that residual is real
//    and is why the list carries the grep that regenerates it.
const ENTITY_PAGE_URL_SLUGS = [
  "nba-top-shot",
  "nfl-all-day",
  "laliga-golazos",
  "ufc",
  "disney-pinnacle",
  "candy-mlb",
  // 2026-09-27 — Panini joined (its entity pages exist: bridged editions/players/
  // sets, absolute media, sets_summary arm, isPanini arms on the pages).
  "panini-blockchain",
]
// Published collections that route NO entity pages. Empty until 2026-09-25,
// when Panini published (Overview + Market) with no /edition, /player, /set
// routes — its WC Prizm cards have no entity corpus yet. A thin collection must
// expose none of ENTITY_LINKING_PAGES EXCEPT a page in FACADE_GATED_PAGES.
// Empty again since 2026-09-27 (Panini joined the facade); the checks below hold
// at a population of zero and re-arm the day a thin collection publishes.
const THIN_PUBLISHED: string[] = []
// Entity-linking pages whose component SUPPRESSES those links when the
// collection has no facade record (MarketClient's `hasEntityPages`, pinned
// below as a source fact). Only these may appear on a thin collection.
const FACADE_GATED_PAGES = ["market"]
// Per-collection tabs whose component for THAT collection renders no entity link
// at all (a native arm, not the Flow board the ENTITY_LINKING_PAGES entry is
// about). 2026-09-27: Panini's Packs tab dispatches to PaniniPackMarket (pack
// products + EV, no card rows), pinned as a source fact below — the arm is only
// exempt while it really links nothing.
// Sets joined 2026-09-27 (PaniniSetProgress — set rows, no card links).
const LINK_FREE_THIN_ARMS: Record<string, string[]> = { "panini-blockchain": ["packs", "sets"] }
const exempt = (id: string, p: string) =>
  FACADE_GATED_PAGES.includes(p) || (LINK_FREE_THIN_ARMS[id] ?? []).includes(p)

// Tabs whose components render a link into the entity corpus. Regenerate with:
//   grep -rln '/edition/\|/player/\|/team/\|/set/\|editionHref\|momentSubjectHref' \
//     'app/(collections)/[collection]'
// `market` is here because omitting it is precisely what shipped 54 dead links.
const ENTITY_LINKING_PAGES = [
  "collection",
  "market",
  "sets",
  "play",
  "challenges",
  "hot-floors",
  "pack-sniper",
  "packs",
  "sniper",
  "analytics",
]

describe("collection-slug facade agrees with the collections.ts registry", () => {
  it("covers exactly the entity-page collections and no more", () => {
    const facadeSlugs = listEntityPageCollections()
      .map((r) => r.urlSlug)
      .sort()
    expect(facadeSlugs).toEqual([...ENTITY_PAGE_URL_SLUGS].sort())
    // The published registry = the entity-page set + the thin ones, exactly.
    expect(publishedCollections().map((c) => c.id).sort()).toEqual([...ENTITY_PAGE_URL_SLUGS, ...THIN_PUBLISHED].sort())
    // And a thin collection exposes nothing the facade would have to route.
    for (const id of THIN_PUBLISHED) {
      const pages = publishedCollections().find((c) => c.id === id)?.pages ?? []
      expect(
        pages.filter((p) => ENTITY_LINKING_PAGES.includes(p) && !exempt(id, p)),
        `${id} exposes an entity-linking page but is not in the facade`,
      ).toEqual([])
      expect(facadeSlugs).not.toContain(id)
    }
  })

  // ⭐ THE ARM THAT WOULD HAVE CAUGHT THE 54 DEAD LINKS, stated in the
  // direction that fails loudly: a published collection that RENDERS entity
  // links must RESOLVE them. Run against the registry on 2026-09-12 (the day
  // Candy's Market tab shipped) this reds; before that day it is green; after
  // this commit it is green again for the right reason.
  it("every published collection that renders entity links resolves through the facade", () => {
    for (const c of publishedCollections()) {
      const linking = c.pages.filter(
        (p) => ENTITY_LINKING_PAGES.includes(p) && !(THIN_PUBLISHED.includes(c.id) && exempt(c.id, p)),
      )
      if (linking.length === 0) continue
      expect(
        getCollectionByUrlSlug(c.id),
        `${c.id} ships ${linking.join("/")} — whose rows link to /${c.id}/edition/... — ` +
          `but is absent from lib/collection-slug.ts, so every one of those links 404s`,
      ).not.toBeNull()
    }
  })

  // The half that makes FACADE_GATED_PAGES mean something: the Market client
  // really does drop edition / player / set links for a facade-less collection.
  it("MarketClient gates every entity link on the facade (FACADE_GATED_PAGES is backed)", () => {
    const src = readFileSync(join(process.cwd(), "app/(collections)/[collection]/market/MarketClient.tsx"), "utf8")
    expect(src).toMatch(/function hasEntityPages\(collectionUrlSlug: string\): boolean \{\s*return getCollectionByUrlSlug\(collectionUrlSlug\) != null/)
    // Card edition link, table edition link, player link, set link.
    expect(src).toContain("listing.editionKey && hasEntityPages(collectionUrlSlug)")
    expect(src).toContain("l.editionKey && entityLinks")
    // 2026-09-27: the plain-name branch also covers Panini subjects with no player page.
    expect(src).toContain("l.playerName && (!entityLinks ||")
    expect(src).toContain("l.setName && !entityLinks")
  })

  // The half that makes LINK_FREE_THIN_ARMS mean something: Panini's Packs tab
  // reaches its own component BEFORE the Flow pack board, and that component
  // emits no link of any kind (so no entity link can 404).
  it("Panini's Packs arm is link-free (LINK_FREE_THIN_ARMS is backed)", () => {
    const view = readFileSync(join(process.cwd(), "components/packs/PackMarketView.tsx"), "utf8")
    const arm = view.indexOf('collection === "panini-blockchain"')
    expect(arm).toBeGreaterThan(-1)
    expect(view.slice(arm, arm + 120)).toContain("<PaniniPackMarket />")
    // …ahead of every Flow board arm inside the component body.
    const body = view.indexOf("export default function PackMarketView")
    expect(body).toBeGreaterThan(-1)
    expect(arm).toBeGreaterThan(body)
    expect(arm).toBeLessThan(view.indexOf("<PackPageClient", body))
    const src = readFileSync(join(process.cwd(), "components/packs/PaniniPackMarket.tsx"), "utf8")
    for (const needle of ["href", "<Link", "/edition/", "/player/", "/set/", "/team/", "router.push"]) {
      expect(src, `PaniniPackMarket must not contain ${needle}`).not.toContain(needle)
    }
  })

  it("Panini's Sets arm is link-free (LINK_FREE_THIN_ARMS is backed)", () => {
    const page = readFileSync(join(process.cwd(), "app/(collections)/[collection]/sets/page.tsx"), "utf8")
    const arm = page.indexOf('collection === "panini-blockchain"')
    expect(arm).toBeGreaterThan(-1)
    expect(page.slice(arm, arm + 80)).toContain("<PaniniSetProgress />")
    expect(arm).toBeLessThan(page.indexOf("return <CollectionSetsClient"))
    const src = readFileSync(join(process.cwd(), "components/collection/PaniniSetProgress.tsx"), "utf8")
    for (const needle of ["href=", "<Link", "/edition/", "/player/", "/set/", "/team/", "router.push"]) {
      expect(src, `PaniniSetProgress must not contain ${needle}`).not.toContain(needle)
    }
  })

  it.each(ENTITY_PAGE_URL_SLUGS)("%s: UUID + dbSlug match across both modules", (urlSlug) => {
    const facade = getCollectionByUrlSlug(urlSlug)
    expect(facade).not.toBeNull()

    // UUID must match COLLECTION_UUID_BY_SLUG in collections.ts.
    expect(facade!.id).toBe(COLLECTION_UUID_BY_SLUG[urlSlug])
    // dbSlug (underscore form) must match SLUG_TO_DB_SLUG in collections.ts.
    expect(facade!.dbSlug).toBe(SLUG_TO_DB_SLUG[urlSlug])
  })

  // displayName was the ONE field of the facade's { id, dbSlug, displayName,
  // urlSlug } record that nothing cross-checked, so a rename in collections.ts
  // (or a typo here) could desync the label every entity page renders while the
  // rest of this suite stayed green. Closed 2026-08-01.
  it.each(ENTITY_PAGE_URL_SLUGS)("%s: displayName matches the registry label", (urlSlug) => {
    const facade = getCollectionByUrlSlug(urlSlug)!
    const canonical = COLLECTIONS.find((c) => c.id === urlSlug)
    expect(canonical).toBeDefined()
    expect(facade.displayName).toBe(canonical!.label)
  })

  it("facade UUID and dbSlug lookups round-trip to the same record", () => {
    for (const urlSlug of ENTITY_PAGE_URL_SLUGS) {
      const byUrl = getCollectionByUrlSlug(urlSlug)!
      expect(getCollectionByUuid(byUrl.id)).toEqual(byUrl)
      expect(getCollectionByDbSlug(byUrl.dbSlug)).toEqual(byUrl)
    }
  })

  it("accepts the 'ufc-strike' alias but still emits the canonical 'ufc' urlSlug", () => {
    const alias = getCollectionByUrlSlug("ufc-strike")
    expect(alias).not.toBeNull()
    expect(alias!.urlSlug).toBe("ufc")
    expect(alias!.dbSlug).toBe("ufc_strike")
    // Alias and canonical resolve to the identical record.
    expect(alias).toEqual(getCollectionByUrlSlug("ufc"))
  })

  // ⚠ Candy was in this list until 2026-09-19 and is deliberately NOT replaced
  // by a weaker assertion — it is now asserted the other way, above and in
  // collection-slug.test.ts. Panini remains, for a CHANGED reason (2026-09-25):
  // it published with Overview + Market only and has no entity routes, so the
  // facade must keep refusing it — a facade record would turn MarketClient's
  // suppressed links back on, and every one of them would 404.
  it("does not expose unpublished chain-two placeholders through the entity facade", () => {
    // INVERTED 2026-09-27: Panini's entity pages now exist, so the facade must
    // route it (a MISSING record would now be the 404 defect). The property the
    // old assertion held — no unpublished placeholder in the facade — is held by
    // rwa, which is still unpublished.
    expect(getCollectionByUrlSlug("panini-blockchain")).not.toBeNull()
    expect(getCollectionByUrlSlug("rwa")).toBeNull()
    expect(getCollectionByUrlSlug("candy-mlb")).not.toBeNull()
  })
})
