// lib/entity/top-fans-targets.ts
//
// Which Top Fans reads an aggregated hub makes (2026-11-27). Pure, so it is unit-tested apart from
// the pages.
//
//   Franchise hub /teams/<league>/<slug>: one `team` read per collection panel that ANSWERED
//   (state "ok"), keyed by the hub's route_slug — the same key the per-collection team page uses —
//   plus Panini through its team map ('NBA:blazers'), as get_panini_franchise_panel.
//   Player hub /players/<slug>: one `player` read per ok panel, keyed by THAT collection's players.id
//   and spelling of the name. ⚠ A NAME IS NOT A PERSON: the page groups by sport and renders one
//   Top Fans section per group, never one table across two athletes.
//
// A failed or empty panel gets no read: a team that collection does not carry has no fans to
// rank there, and a panel that could not be read is already shown as unavailable above.

import { getCollectionByUuid, type CollectionSlugInfo } from "@/lib/collection-slug"
import type { TopFansKind } from "@/lib/entity/top-fans-format"

export const PANINI_COLLECTION_ID = "d1a0a7f5-609a-49f4-a1a7-4eaac55b020b"

export interface TopFansTargetSpec {
  collection: CollectionSlugInfo
  kind: TopFansKind
  key: string
  name?: string | null
}

export function paniniFranchiseKey(league: string, teamSlug: string): string {
  return `${league.trim().toUpperCase()}:${teamSlug.trim().toLowerCase()}`
}

export function franchiseHubTopFansTargets(
  hub: { league: string; team_slug: string; route_slug: string },
  panels: Array<{ state: string; collection: CollectionSlugInfo }>,
  panini: { state: string },
): TopFansTargetSpec[] {
  const out: TopFansTargetSpec[] = panels
    .filter((p) => p.state === "ok")
    .map((p) => ({ collection: p.collection, kind: "team" as const, key: hub.route_slug }))
  const paniniColl = getCollectionByUuid(PANINI_COLLECTION_ID)
  if (panini.state === "ok" && paniniColl && !out.some((t) => t.collection.id === PANINI_COLLECTION_ID)) {
    out.push({ collection: paniniColl, kind: "franchise", key: paniniFranchiseKey(hub.league, hub.team_slug) })
  }
  return out
}

export function playerHubTopFansTargets(
  panels: Array<{ state: string; collection: CollectionSlugInfo; entry: { name: string }; detail?: { id?: string | null; name?: string | null } }>,
): TopFansTargetSpec[] {
  return panels.flatMap((p) => {
    if (p.state !== "ok" || !p.detail?.id) return []
    return [{ collection: p.collection, kind: "player" as const, key: p.detail.id, name: p.detail.name ?? p.entry.name }]
  })
}
