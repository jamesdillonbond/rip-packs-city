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
  type MarketCapEntityGroup,
  type MarketCapEntityRow,
} from "@/lib/insights/market-cap-board"

export async function fetchMarketCapTileRow(
  group: MarketCapEntityGroup,
  collectionDbSlug: string,
  match: string,
): Promise<MarketCapEntityRow | null> {
  return withBoardBudget(fetchMarketCapEntity(supabaseAdmin, group, collectionDbSlug, match), `market-cap ${group}`)
}
