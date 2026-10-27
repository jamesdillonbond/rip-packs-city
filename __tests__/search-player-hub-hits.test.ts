// __tests__/search-player-hub-hits.test.ts
//
// lib/search/player-hub-hits.ts (2026-10-22). Searching "damian lillard" listed
// a Panini row and a Top Shot row for the same name, and Enter opened the Panini
// page. Pins: one row per player name, linking the collection-agnostic hub, in
// the position of the highest-ranked row; everything else untouched.

import { describe, expect, it } from "vitest"
import { mergePlayerHubHits, type SearchResultWithSlug } from "@/lib/search/player-hub-hits"

const row = (o: Partial<SearchResultWithSlug>): SearchResultWithSlug => ({
  collectionId: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  kind: "player",
  label: "Damian Lillard",
  sublabel: null,
  href: "/x",
  collection: "nba-top-shot",
  collectionName: "NBA Top Shot",
  thumbnailUrl: null,
  editionCount: 1,
  slug: "damian-lillard",
  ...o,
})

describe("mergePlayerHubHits", () => {
  it("collapses one name's per-collection rows into one hub row at the first row's position", () => {
    const out = mergePlayerHubHits([
      row({ collection: "panini-blockchain", collectionName: "Panini Blockchain", editionCount: 129, href: "/panini-blockchain/player/damian-lillard" }),
      row({ editionCount: 68, href: "/nba-top-shot/player/damian-lillard", thumbnailUrl: "https://x/ts.jpg" }),
      row({ kind: "edition", label: "Damian Lillard", slug: "8:145", href: "/nba-top-shot/edition/8%3A145" }),
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      kind: "player",
      href: "/players/damian-lillard",
      collectionName: "Panini Blockchain + NBA Top Shot",
      collections: ["panini-blockchain", "nba-top-shot"],
      // Re-pinned 2026-10-27: never summed across collections — a name can be two athletes (see below).
      editionCount: null,
      thumbnailUrl: "https://x/ts.jpg",
    })
    // The hub row is what Enter opens — it must not be a single collection's page.
    expect(out[0].href).not.toMatch(/^\/panini-blockchain\//)
    expect(out[1].href).toBe("/nba-top-shot/edition/8%3A145")
  })

  it("links a single-collection player row to the hub too (the hub folds aliases, or redirects)", () => {
    const out = mergePlayerHubHits([row({ label: "Steph Curry", slug: "steph-curry" })])
    expect(out[0].href).toBe("/players/steph-curry")
  })

  it("keeps different names apart", () => {
    const out = mergePlayerHubHits([
      row({}),
      row({ label: "Damian Lillard | Donovan Mitchell", slug: "damian-lillard-donovan-mitchell", collection: "panini-blockchain" }),
    ])
    expect(out).toHaveLength(2)
  })

  it("leaves Disney Pinnacle characters on their collection page", () => {
    const out = mergePlayerHubHits([row({ collection: "disney-pinnacle", label: "Stitch", slug: "stitch", href: "/disney-pinnacle/player/stitch" })])
    expect(out[0].href).toBe("/disney-pinnacle/player/stitch")
  })

  it("does not leak the internal slug field", () => {
    expect(mergePlayerHubHits([row({})])[0]).not.toHaveProperty("slug")
  })

  it("never adds two athletes' editions together (a basketball and a football Larry Johnson, 2026-10-27)", () => {
    const out = mergePlayerHubHits([
      row({ label: "Larry Johnson", slug: "larry-johnson", editionCount: 11, href: "/nba-top-shot/player/larry-johnson" }),
      row({ label: "Larry Johnson", slug: "larry-johnson", collection: "nfl-all-day", collectionName: "NFL All Day", editionCount: 3, href: "/nfl-all-day/player/larry-johnson" }),
    ])
    expect(out[0].editionCount).toBeNull()
    expect(out[0].editionCount).not.toBe(14)
  })
  it("CONTROL: a single-collection row keeps its own count", () => {
    const out = mergePlayerHubHits([row({ label: "Steph Curry", slug: "steph-curry", editionCount: 42 })])
    expect(out[0].editionCount).toBe(42)
  })
})
