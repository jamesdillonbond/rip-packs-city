// lib/entity/top-fans.ts
//
// Top Fans (Trevor, 2026-11-27): "Each team and player should have top fans on their hubs … top
// collectors by Moment/Pin/Card count, FMV, and special serial count owned (only count each
// Moment/pin/card once, if they have multiple special serials on it like a 1/1 that is both #1 and
// perfect)."
//
// ONE reader for every surface — the per-collection team / player / character pages and the
// aggregated hubs (/teams/<league>/<slug>, /players/<slug>): get_entity_top_fans over the daily
// entity_top_fans precompute (migration 20261128000240). The hub and the page it links to read the
// same rows, so they cannot disagree.
//
// THREE STATES, never two: `ok:false` = could not ask (renders unavailable); `ok:true, data:null` =
// the collection's precompute has never been built (also unavailable — we did not measure, so we
// do not say "no fans"); `ok:true, data.rows=[]` = measured, nobody we can see holds this one.

import { sectionRowResult } from "@/lib/entity-section-rpc"
import { normalizeTopFans, TOP_FANS_LIMIT, type TopFansData, type TopFansKind } from "@/lib/entity/top-fans-format"

export * from "@/lib/entity/top-fans-format"

export async function fetchTopFans(args: {
  collectionId: string
  kind: TopFansKind
  /** team slug · players.id · Panini franchise key ('NBA:blazers') */
  key: string
  /** players.name (the player arm adds same-name ids; Pinnacle keys on it) */
  name?: string | null
  limit?: number
}): Promise<{ ok: boolean; data: TopFansData | null }> {
  const { row, ok } = await sectionRowResult<unknown>("top fans", "get_entity_top_fans", {
    p_collection_id: args.collectionId,
    p_kind: args.kind,
    p_key: args.key,
    p_name: args.name ?? null,
    p_limit: args.limit ?? TOP_FANS_LIMIT,
  })
  return { ok, data: ok ? normalizeTopFans(row) : null }
}

