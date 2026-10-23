// __tests__/search-team-hub-hits.test.ts
//
// lib/search/team-hub-hits.ts (2026-10-22): search team rows open the franchise
// hub, named by the franchise, one row per franchise; a row with no franchise
// key keeps its collection link (that page exists — the fallback asserts nothing).

import { describe, expect, it } from "vitest"
import { mergeTeamHubHits, type FranchiseHubKey } from "@/lib/search/team-hub-hits"
import type { SearchResultWithSlug } from "@/lib/search/player-hub-hits"

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const PIN = "7dd9dd11-e8b6-45c4-ac99-71331f959714"

const row = (o: Partial<SearchResultWithSlug>): SearchResultWithSlug => ({
  kind: "team",
  label: "Portland Trail Blazers",
  sublabel: null,
  href: "/nba-top-shot/team/portland-trail-blazers",
  collection: "nba-top-shot",
  collectionName: "NBA Top Shot",
  thumbnailUrl: null,
  editionCount: 10,
  slug: "portland-trail-blazers",
  collectionId: TS,
  ...o,
})
const key = (team_slug: string, hub_slug: string, team_name: string): FranchiseHubKey => ({
  collection_id: TS, team_slug, league: "NBA", hub_slug, team_name,
})

describe("mergeTeamHubHits", () => {
  it("links a keyed team row to its hub", () => {
    const out = mergeTeamHubHits([row({})], [key("portland-trail-blazers", "blazers", "Portland Trail Blazers")])
    expect(out[0].href).toBe("/teams/nba/blazers")
  })

  it("names a historic label's row by its franchise and collapses the franchise's labels", () => {
    const out = mergeTeamHubHits(
      [
        row({ label: "Seattle SuperSonics", slug: "seattle-supersonics", editionCount: 4 }),
        row({ kind: "player", label: "Kevin Durant", slug: "kevin-durant", href: "/x" }),
        row({ label: "Oklahoma City Thunder", slug: "oklahoma-city-thunder", editionCount: 90 }),
      ],
      [key("seattle-supersonics", "thunder", "Oklahoma City Thunder"), key("oklahoma-city-thunder", "thunder", "Oklahoma City Thunder")],
    )
    expect(out.map((r) => r.label)).toEqual(["Oklahoma City Thunder", "Kevin Durant"])
    expect(out[0]).toMatchObject({ href: "/teams/nba/thunder", editionCount: 94, collections: ["nba-top-shot"] })
  })

  it("keeps the collection link for a team with no franchise (a Pinnacle franchise)", () => {
    const r = row({ collection: "disney-pinnacle", collectionId: PIN, label: "Star Wars", slug: "star-wars", href: "/disney-pinnacle/team/star-wars" })
    expect(mergeTeamHubHits([r], [])[0].href).toBe("/disney-pinnacle/team/star-wars")
  })

  it("matches keys by collection AND slug, never slug alone", () => {
    const out = mergeTeamHubHits([row({ collectionId: PIN })], [key("portland-trail-blazers", "blazers", "Portland Trail Blazers")])
    expect(out[0].href).toBe("/nba-top-shot/team/portland-trail-blazers")
  })
})
