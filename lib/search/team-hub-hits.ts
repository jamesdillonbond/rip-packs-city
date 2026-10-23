// lib/search/team-hub-hits.ts
//
// Search team rows -> franchise hub links (2026-10-22). Same move as
// player-hub-hits.ts, for teams: rpc_search_catalog returns one team row per
// collection LABEL, so the Blazers' row opened Top Shot's team page alone, and
// a franchise's historic labels ("Seattle SuperSonics", "Oklahoma City
// Thunder") were separate rows. Now every team row whose label belongs to a
// registered franchise links /teams/<league>/<slug> — the hub that also
// carries Panini's cards — named by the franchise, and rows of one franchise
// collapse into one at the first (highest-ranked) row's position.
//
// A row with no franchise key (a Pinnacle franchise like Star Wars, a label no
// registry knows, or a key lookup that failed) keeps its collection link: that
// page exists and is correct, so falling back to it asserts nothing false.

import { franchiseHubPath } from "@/lib/franchise-hub-path"
import type { SearchResultWithSlug } from "@/lib/search/player-hub-hits"

export interface FranchiseHubKey {
  collection_id: string
  team_slug: string
  league: string
  hub_slug: string
  team_name: string
}

export function teamKeyId(collectionId: string, teamSlug: string): string {
  return `${collectionId}|${teamSlug}`
}

export function mergeTeamHubHits(rows: SearchResultWithSlug[], keys: FranchiseHubKey[]): SearchResultWithSlug[] {
  const byPair = new Map(keys.map((k) => [teamKeyId(k.collection_id, k.team_slug), k]))
  const out: SearchResultWithSlug[] = []
  const byHub = new Map<string, SearchResultWithSlug>()
  for (const r of rows) {
    const key = r.kind === "team" ? byPair.get(teamKeyId(r.collectionId, r.slug)) : undefined
    if (!key) {
      out.push(r)
      continue
    }
    const hubId = `${key.league}:${key.hub_slug}`
    const seen = byHub.get(hubId)
    if (!seen) {
      const hit: SearchResultWithSlug = {
        ...r,
        label: key.team_name,
        href: franchiseHubPath(key.league, key.hub_slug),
        collections: [r.collection],
      }
      byHub.set(hubId, hit)
      out.push(hit)
      continue
    }
    if (!seen.collections?.includes(r.collection)) {
      seen.collections = [...(seen.collections ?? []), r.collection]
      seen.collectionName = `${seen.collectionName} + ${r.collectionName}`
    }
    seen.editionCount =
      seen.editionCount == null && r.editionCount == null ? null : (seen.editionCount ?? 0) + (r.editionCount ?? 0)
    seen.thumbnailUrl = seen.thumbnailUrl ?? r.thumbnailUrl
  }
  return out
}
