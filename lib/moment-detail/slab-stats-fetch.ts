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
import { asCardLeague, asEspnLeague, cardSeason, cardSlabStats, momentSeason, type MomentGameContext, type SeasonLine, type SlabStats } from "@/lib/slab-stats"
import { marketCapKey } from "@/lib/player-recent-games"

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
 * The edition a slab-stats read is for. `game_date` gates the read on /moment, which knows the date.
 * An EDITION page (2026-11-26, the slab on every collection) does not select one, so it passes
 * `date_from_db: true`: the DB function reads the edition's own date, and a missing date there is
 * a null context, never a guessed season. The season-only fallback (function missing) still needs
 * a known date, so with no date it reads nothing.
 */
export type SlabStatsEdition = {
  id: string
  collection_slug: string | null
  game_date: string | null
  date_from_db?: boolean
}

/**
 * The whole read — up to three sequential calls on the fallback path — runs under ONE 4 s budget,
 * the same bound every other read in the Moment page's Promise.all has, so the page ceiling stays
 * 4 s + 4 s (lib/moment-detail/fetchers.ts). An overrun is a failed read: no stats on the slab.
 */
export async function fetchSlabStats(
  edition: SlabStatsEdition,
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
  edition: SlabStatsEdition,
  client: RpcClient,
): Promise<SlabStatsRead> {
  if (!edition.collection_slug || !SLAB_STATS_COLLECTIONS.has(edition.collection_slug) || (!edition.game_date && !edition.date_from_db)) {
    return { ok: true, ctx: null }
  }
  const primary = await client.rpc("get_moment_game_context", { p_edition_id: edition.id })
  if (!primary.error) {
    return { ok: true, ctx: (primary.data as MomentGameContext | null) ?? null }
  }
  if (!isFunctionMissing(primary.error)) {
    return { ok: false, error: primary.error.message ?? "get_moment_game_context failed" }
  }

  // Fallback: the season lines only — and only with a date we were given (no season is guessed).
  if (!edition.game_date) return { ok: true, ctx: null }
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

// ── Cards (2026-11-26: the slab on every collection) ────────────────────────────────────────────
// A Panini or Candy card has no game, so its back carries the season line for the season the card
// is from (lib/slab-stats cardSeason). Candy MLB players are keyed through player_identities
// (get_player_season_stats, by the edition's player_id); Panini players through the one-person
// panini_espn_crosswalk by name slug (get_panini_player_season_stats — the player hub's read).
// Same three states as above: ok:false = a read failed; stats null = nothing to show.

export const CARD_SLAB_STATS_COLLECTIONS = new Set(["panini_blockchain", "candy_mlb"])

export type CardSlabStatsRead = { ok: true; stats: SlabStats | null } | { ok: false; error: string }

export type CardSlabStatsEdition = {
  id: string
  collection_slug: string | null
  set_name: string | null
  /** editions.external_id — a Panini card's product (`packcard-<set_id>_…`), whose name carries the season. */
  external_id?: string | null
  /** The names this card's player goes by (Panini's label, the linked player's name) — slugged for the crosswalk. */
  player_names: Array<string | null | undefined>
}

type SeasonStatsPayload = {
  league?: string | null
  espn_league?: string | null
  rows?: Array<SeasonLine & { season: number; season_type?: number }>
} | null

export async function fetchCardSlabStats(
  card: CardSlabStatsEdition,
  client: RpcClient = supabaseAdmin as unknown as RpcClient,
  timeoutMs = 4_000,
): Promise<CardSlabStatsRead> {
  try {
    return await withBoardBudget(readCardSlabStats(card, client), "card slab stats", timeoutMs, "edition-page/")
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function readCardSlabStats(card: CardSlabStatsEdition, client: RpcClient): Promise<CardSlabStatsRead> {
  if (!card.collection_slug || !CARD_SLAB_STATS_COLLECTIONS.has(card.collection_slug)) return { ok: true, stats: null }
  let payload: SeasonStatsPayload
  let productName: string | null = null
  if (card.collection_slug === "panini_blockchain") {
    const slugs = Array.from(new Set(card.player_names.map((n) => (n ? marketCapKey(n) : "")).filter((x) => x.length > 0)))
    if (slugs.length === 0) return { ok: true, stats: null }
    // The season is usually in the PRODUCT's name ("2021-22 Panini NFT Noir Basketball"); the card's own
    // set name is usually just "Base Prizms Silver". A failed product read is a failed read.
    const setId = /^packcard-(\d+)_/.exec(card.external_id ?? "")?.[1] ?? null
    const [r, prod] = await Promise.all([
      client.rpc("get_panini_player_season_stats", { p_slugs: slugs, p_seasons: 20 }),
      setId
        ? client.from("panini_products").select("name").eq("set_id", Number(setId)).limit(1).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ])
    if (r.error) return { ok: false, error: r.error.message ?? "get_panini_player_season_stats failed" }
    if (prod.error) return { ok: false, error: prod.error.message ?? "panini_products read failed" }
    payload = r.data as SeasonStatsPayload
    productName = (prod.data as { name?: string | null } | null)?.name ?? null
  } else {
    const ed = await client.from("editions").select("player_id").eq("id", card.id).limit(1).maybeSingle()
    if (ed.error) return { ok: false, error: ed.error.message ?? "editions read failed" }
    const playerId = (ed.data as { player_id?: string | null } | null)?.player_id ?? null
    if (!playerId) return { ok: true, stats: null }
    const r = await client.rpc("get_player_season_stats", { p_player_id: playerId, p_seasons: 20 })
    if (r.error) return { ok: false, error: r.error.message ?? "get_player_season_stats failed" }
    payload = r.data as SeasonStatsPayload
  }
  if (!payload) return { ok: true, stats: null }
  // A WNBA player is keyed under the nba identity league; her seasons are calendar years.
  const league = payload.espn_league === "wnba" ? "wnba" : asCardLeague(payload.league)
  // The card's own set name when it names a season ("BC 2021-22 Donruss Net Marvels" sits in a
  // product called "2021 Panini Blockchain NBA Packs …"), else the product's.
  const seasonSource = league && cardSeason(league, card.set_name) != null ? card.set_name : productName ?? card.set_name
  return { ok: true, stats: cardSlabStats(league, seasonSource, payload.rows ?? []) }
}
