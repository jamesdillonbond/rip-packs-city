// lib/moment-detail/slab-stats-fetch.ts — the player stats on the back of the Moment slab.
//
// 2026-11-25. Reads public.get_moment_game_context(edition) — the game line plus that season's
// lines in one call (supabase/migrations/20261126020013_audit_20261125_moment_game_lines.sql,
// applied 2026-11-25 ~6:00 PM PT). If PostgREST ever answers PGRST202 "function not found" (a
// rollback of that migration), this falls back to the season lines alone through
// get_player_season_stats rather than losing the block.
//
// Three states, kept apart:
//   ok:false            → a read failed: the slab shows no stats (no claim either way)
//   ok:true, ctx null   → nothing to key (not a Top Shot / All Day Moment, no player, no ESPN id)
//   ok:true, ctx        → the lines

import { supabaseAdmin } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import { asEspnLeague, momentSeason, type MomentGameContext, type SeasonLine } from "@/lib/slab-stats"

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, v: unknown) => {
        limit: (n: number) => { maybeSingle: () => PromiseLike<{ data: unknown; error: { message?: string } | null }> }
      }
    }
  }
}

// laliga_golazos (2026-11-26): the match result, from ESPN's LaLiga scoreboard (get_moment_game_context).
export const SLAB_STATS_COLLECTIONS = new Set(["nba_top_shot", "nfl_all_day", "laliga_golazos"])

export type SlabStatsRead = { ok: true; ctx: MomentGameContext | null } | { ok: false; error: string }

export function isFunctionMissing(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false
  return err.code === "PGRST202" || /could not find the function/i.test(err.message ?? "")
}

/**
 * The whole read — up to three sequential calls on the fallback path — runs under ONE 4 s budget,
 * the same bound every other read in the Moment page's Promise.all has, so the page ceiling stays
 * 4 s + 4 s (lib/moment-detail/fetchers.ts). An overrun is a failed read: no stats on the slab.
 */
export async function fetchSlabStats(
  edition: { id: string; collection_slug: string | null; game_date: string | null },
  client: RpcClient = supabaseAdmin as unknown as RpcClient,
  timeoutMs = 4_000,
): Promise<SlabStatsRead> {
  try {
    return await withBoardBudget(readSlabStats(edition, client), "slab stats", timeoutMs, "moment-page/")
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function readSlabStats(
  edition: { id: string; collection_slug: string | null; game_date: string | null },
  client: RpcClient,
): Promise<SlabStatsRead> {
  if (!edition.collection_slug || !SLAB_STATS_COLLECTIONS.has(edition.collection_slug) || !edition.game_date) {
    return { ok: true, ctx: null }
  }
  const primary = await client.rpc("get_moment_game_context", { p_edition_id: edition.id })
  if (!primary.error) {
    return { ok: true, ctx: (primary.data as MomentGameContext | null) ?? null }
  }
  if (!isFunctionMissing(primary.error)) {
    return { ok: false, error: primary.error.message ?? "get_moment_game_context failed" }
  }

  // Fallback: the season lines only.
  const ed = await client.from("editions").select("player_id").eq("id", edition.id).limit(1).maybeSingle()
  if (ed.error) return { ok: false, error: ed.error.message ?? "editions read failed" }
  const playerId = (ed.data as { player_id?: string | null } | null)?.player_id ?? null
  if (!playerId) return { ok: true, ctx: null }

  const ss = await client.rpc("get_player_season_stats", { p_player_id: playerId, p_seasons: 20 })
  if (ss.error) return { ok: false, error: ss.error.message ?? "get_player_season_stats failed" }
  const res = ss.data as { espn_league?: string | null; league?: string; rows?: Array<SeasonLine & { season: number; season_type?: number }> } | null
  if (!res) return { ok: true, ctx: null }
  const league = asEspnLeague(res.espn_league ?? res.league)
  if (!league) return { ok: true, ctx: null }
  const season = momentSeason(league, edition.game_date)
  if (season == null) return { ok: true, ctx: null }
  const rows = (res.rows ?? []).filter((r) => r.season === season && (r.season_type == null || r.season_type === 2))
  return {
    ok: true,
    ctx: { league: res.league, espn_league: league, season, moment_game_date: edition.game_date, season_rows: rows, game: null },
  }
}
