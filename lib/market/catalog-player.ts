// lib/market/catalog-player.ts
//
// #207: accent-blind player resolution for the collections whose player filter
// runs in the database (Top Shot, All Day, Golazos). Their reads match the typed
// name with an accent-SENSITIVE ilike, so "luka doncic" finds nothing for "Luka
// Dončić". When such a search matched NOTHING, the caller resolves the typed text
// against the collection's player catalog (get_market_filter_options — ~115 ms,
// so it runs only on an empty search and is memoized per instance for an hour),
// retries with the single name it finds, and REPORTS the swap.
//
// Shared by /api/market and /api/sniper-feed (the Sniper's Top Shot pool, the All
// Day RPC and the Golazos RPC had the same accent-sensitive match: "doncic" →
// 0 deals, "Dončić" → 96 on 2026-10-22). A failed catalog read resolves nothing:
// the empty answer stands, as before.

import { supabaseAdmin } from "@/lib/supabase"
import { boundedRead } from "@/lib/api/bounded-read"
import { DB_FILTERED_MARKET_COLLECTION_IDS } from "@/lib/market/edition-market-arms"
import { resolveAccentedPlayer } from "@/lib/market/player-match"

/** Collection UUIDs whose player search is matched in the database. */
export const CATALOG_PLAYER_COLLECTIONS = DB_FILTERED_MARKET_COLLECTION_IDS

const CATALOG_PLAYERS_TTL_MS = 60 * 60 * 1000
const catalogPlayersMemo = new Map<string, { at: number; names: string[] }>()

/** The single catalog name an empty `typed` search should be retried with, or null. */
export async function resolveCatalogPlayer(collectionId: string, typed: string, caller: string): Promise<string | null> {
  let hit = catalogPlayersMemo.get(collectionId)
  if (!hit || Date.now() - hit.at > CATALOG_PLAYERS_TTL_MS) {
    const db = supabaseAdmin as unknown as { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> }
    const { data, error } = await boundedRead(
      db.rpc("get_market_filter_options", { p_collection_id: collectionId }),
      `${caller}/player-resolve`,
    )
    const players = data != null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).players
      : null
    if (error || !Array.isArray(players)) {
      console.error(`[${caller}] player catalog unavailable — no accent resolution`, error?.message ?? "bad payload")
      return null
    }
    hit = { at: Date.now(), names: players.filter((v): v is string => typeof v === "string" && v !== "") }
    catalogPlayersMemo.set(collectionId, hit)
  }
  return resolveAccentedPlayer(typed, hit.names)
}
