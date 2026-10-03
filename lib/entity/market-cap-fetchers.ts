// lib/entity/market-cap-fetchers.ts
//
// The market-cap tile's server read (components/entity/MarketCapTile.tsx), kept in
// lib/ so page-level components hold no DB client (server-page-data-access ratchet).
// Bounded by the shared board budget; THROWS on a failed or slow read so the tile
// can say "couldn't load" instead of rendering nothing.

import { supabaseAdmin } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import {
  fetchMarketCapEntity,
  staleSince,
  type MarketCapEntityGroup,
  type MarketCapEntityRow,
} from "@/lib/insights/market-cap-board"
import { fetchTopShotIssuerSplitEdition } from "@/lib/insights/topshot-issuer-split"
import type { IssuerSplitEditionRow } from "@/lib/insights/topshot-issuer-split-format"

// Re-exported so the tile (and any other server component) can take its types
// from THIS bounded module instead of importing from the one that holds the reads.
export type { MarketCapEntityGroup, MarketCapEntityRow, IssuerSplitEditionRow }

export async function fetchMarketCapTileRow(
  group: MarketCapEntityGroup,
  collectionDbSlug: string,
  match: string,
): Promise<{ row: MarketCapEntityRow | null; stale: string | null }> {
  const row = await withBoardBudget(fetchMarketCapEntity(supabaseAdmin, group, collectionDbSlug, match), `market-cap ${group}`)
  return { row, stale: row ? staleSince(row.refreshed_at, Date.now()) : null }
}

/**
 * One Top Shot edition's issuer-held split (inside unopened packs vs reserve), same
 * budget. `null` = not a Top Shot edition; THROWS on a failed or slow read.
 */
export async function fetchIssuerSplitTileRow(externalId: string): Promise<IssuerSplitEditionRow | null> {
  return withBoardBudget(fetchTopShotIssuerSplitEdition(supabaseAdmin, externalId), "issuer-held split edition")
}
