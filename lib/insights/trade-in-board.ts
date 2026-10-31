// lib/insights/trade-in-board.ts
//
// Shared read for the public /insights/trade-in board (page + /api/public route).
// Backed by public.v_insights_trade_in (security_invoker = on, anon-granted;
// migration 20261031182000): one row per NBA Top Shot edition that carries BOTH
// Top Shot's own average sale price and a live low ask. Top Shot's Series 2026-27
// program counts every $10 of a player's Moments, at that average sale price, as one
// Top Shot This pack of that player — so for each edition the board says how many
// Moments reach $10 and what buying them at the ask costs.
//
// ⛔ No FMV and no confidence here by design: the figure that matters is Top Shot's
// (badge_editions.avg_sale_price, Atlas `averageSalePriceCents`), because that is
// what the trade-in counts. The ask is the lowest listing Top Shot reports: ONE
// Moment at that price is confirmed, the next may cost more, and the copy says so.
//
// The `?wallet=` arm (get_topshot_trade_in_wallet, one scan) sums the same ASP over
// a wallet's indexed Top Shot Moments per player — whole packs earned, ASP to the
// next — and, per player, the CHEAPEST NEXT PACK: the listed Moment(s) of that
// player that close the gap at the least cost (ceil(gap ÷ ASP) × lowest ask). A
// Moment with no ASP is counted, never valued at $0; a player with no priced
// listing has no fill, never a $0 one. Players are keyed on the CATALOG name
// (editions.player_name), the one the board and the player pages use.

import { retryEmptyWithAccentRegex } from "@/lib/search/accent-regex"

export const TRADE_IN_SORTS = ["cost", "ratio", "asp"] as const
export type TradeInSort = (typeof TRADE_IN_SORTS)[number]

/** Top Shot's rule: this much ASP per pack. Stated on the page; change here if Top Shot changes it. */
export const ASP_PER_PACK_USD = 10

export type TradeInRow = {
  edition_id: string
  external_id: string
  player_name: string | null
  team_name: string | null
  set_name: string | null
  printing: string
  tier: string | null
  series: number | null
  circulation_count: number | null
  live_supply: number | null
  /** Top Shot's own average sale price. */
  asp: number
  low_ask: number
  moments_per_pack: number
  cost_per_pack: number
  asp_to_ask: number
  asp_at: string | null
}

/** The cheapest listed way to reach a player's next pack: `moments_needed` of one edition at its lowest ask. */
export type TradeInFill = {
  player_name: string
  packs: number
  to_next_pack: number
  edition_id: string
  external_id: string
  set_name: string | null
  printing: string
  tier: string | null
  series: number | null
  asp: number
  low_ask: number
  moments_needed: number
  cost: number
}

export type TradeInPortfolioRow = {
  player_name: string
  moments: number
  moments_with_asp: number
  asp_total: number
  packs: number
  to_next_pack: number
  /** Players in the whole wallet (the function returns the top `p_limit` by ASP). */
  total_players: number
  /** This player's cheapest next pack; `null` = no listing with a Top Shot ASP right now. */
  fill?: TradeInFill | null
}

export type TradeInWallet = {
  wallet: string
  total_players: number
  players_with_fill: number
  /** Most ASP first, capped at the function's limit. */
  players: TradeInPortfolioRow[]
  /** Cheapest next pack first, across every player in the wallet, capped at the same limit. */
  next_pack: TradeInFill[]
}

const COLS = [
  "edition_id", "external_id", "player_name", "team_name", "set_name", "printing", "tier", "series",
  "circulation_count", "live_supply", "asp", "low_ask", "moments_per_pack", "cost_per_pack", "asp_to_ask", "asp_at",
].join(", ")

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null
}

/** A row the view could not have produced (no ASP or ask) is dropped, never rendered as $0. */
export function normalizeTradeInRow(raw: Record<string, unknown>): TradeInRow | null {
  const asp = num(raw.asp)
  const lowAsk = num(raw.low_ask)
  const mpp = num(raw.moments_per_pack)
  const cpp = num(raw.cost_per_pack)
  const ratio = num(raw.asp_to_ask)
  if (asp == null || lowAsk == null || mpp == null || cpp == null || ratio == null || asp <= 0 || lowAsk <= 0) return null
  return {
    edition_id: String(raw.edition_id ?? ""),
    external_id: String(raw.external_id ?? ""),
    player_name: str(raw.player_name),
    team_name: str(raw.team_name),
    set_name: str(raw.set_name),
    printing: str(raw.printing) ?? "Standard",
    tier: str(raw.tier),
    series: num(raw.series),
    circulation_count: num(raw.circulation_count),
    live_supply: num(raw.live_supply),
    asp,
    low_ask: lowAsk,
    moments_per_pack: mpp,
    cost_per_pack: cpp,
    asp_to_ask: ratio,
    asp_at: str(raw.asp_at),
  }
}

/** A fill the function could not have produced (no ask, no ASP, nothing to buy) is dropped, never rendered as $0. */
export function normalizeFill(raw: unknown): TradeInFill | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const player = str(r.player_name)
  const asp = num(r.asp)
  const lowAsk = num(r.low_ask)
  const needed = num(r.moments_needed)
  const cost = num(r.cost)
  const externalId = str(r.external_id)
  if (!player || !externalId || asp == null || lowAsk == null || needed == null || cost == null || asp <= 0 || lowAsk <= 0 || needed < 1) return null
  return {
    player_name: player,
    packs: num(r.packs) ?? 0,
    to_next_pack: num(r.to_next_pack) ?? ASP_PER_PACK_USD,
    edition_id: String(r.edition_id ?? ""),
    external_id: externalId,
    set_name: str(r.set_name),
    printing: str(r.printing) ?? "Standard",
    tier: str(r.tier),
    series: num(r.series),
    asp,
    low_ask: lowAsk,
    moments_needed: needed,
    cost,
  }
}

export function normalizePortfolioRow(raw: Record<string, unknown>, totalPlayers?: number): TradeInPortfolioRow | null {
  const player = str(raw.player_name)
  const moments = num(raw.moments)
  if (!player || moments == null) return null
  const row: TradeInPortfolioRow = {
    player_name: player,
    moments,
    moments_with_asp: num(raw.moments_with_asp) ?? 0,
    asp_total: num(raw.asp_total) ?? 0,
    packs: num(raw.packs) ?? 0,
    to_next_pack: num(raw.to_next_pack) ?? ASP_PER_PACK_USD,
    total_players: num(raw.total_players) ?? totalPlayers ?? 0,
  }
  if ("fill" in raw) row.fill = normalizeFill(raw.fill)
  return row
}

export function tradeInEditionHref(externalId: string): string {
  return `/nba-top-shot/edition/${encodeURIComponent(externalId)}`
}

type BoardQuery = {
  select: (cols: string) => BoardQuery
  ilike: (col: string, pattern: string) => BoardQuery
  filter: (col: string, op: string, value: string) => BoardQuery
  order: (col: string, opts: { ascending: boolean; nullsFirst?: boolean }) => BoardQuery
  limit: (n: number) => PromiseLike<{ data: Array<Record<string, unknown>> | null; error: { message?: string } | null }>
}
export type TradeInBoardClient = {
  from: (t: string) => BoardQuery
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>
}

/** Strips LIKE wildcards from a typed player filter so a user cannot widen the match. */
export function cleanPlayerFilter(raw: string | null | undefined): string {
  return String(raw ?? "").replace(/[%_\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 60)
}

export async function fetchTradeInBoard(
  db: TradeInBoardClient,
  opts: { player?: string | null; sort: TradeInSort; limit: number },
): Promise<{ data: TradeInRow[] | null; error: { message?: string } | null }> {
  const player = cleanPlayerFilter(opts.player)
  // Rebuilt per run (a supabase-js builder mutates in place), so the accent-blind
  // retry below can swap the ilike for an imatch and keep sort + limit (#207).
  const build = (accentRegex: string | null) => {
    let q = db.from("v_insights_trade_in").select(COLS)
    if (accentRegex) q = q.filter("player_name", "imatch", accentRegex)
    else if (player) q = q.ilike("player_name", `%${player}%`)
    switch (opts.sort) {
      case "ratio":
        q = q.order("asp_to_ask", { ascending: false })
        break
      case "asp":
        q = q.order("asp", { ascending: false })
        break
      default:
        q = q.order("cost_per_pack", { ascending: true })
    }
    // Deterministic tiebreak on a UNIQUE key so a page never reorders between reads.
    return q.order("edition_id", { ascending: true }).limit(opts.limit)
  }
  const first = await build(null)
  // "jokic" must find "Jokić": an answered empty is re-run once accent-blind.
  const { data, error } = await retryEmptyWithAccentRegex(player, first, (rx) => build(rx))
  if (error) return { data: null, error }
  return { data: (data ?? []).map(normalizeTradeInRow).filter((r): r is TradeInRow => r !== null), error: null }
}

/** The function's own cap; PostgREST would clamp a longer answer at 1,000 rows silently. */
export const PORTFOLIO_PLAYERS = 200

export async function fetchTradeInPortfolio(
  db: TradeInBoardClient,
  wallet: string,
  limit: number = PORTFOLIO_PLAYERS,
): Promise<{ data: TradeInPortfolioRow[] | null; error: { message?: string } | null }> {
  const { data, error } = await db.rpc("get_topshot_trade_in_portfolio", { p_wallet: wallet, p_limit: limit })
  if (error) return { data: null, error }
  const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []
  return { data: rows.map(normalizePortfolioRow).filter((r): r is TradeInPortfolioRow => r !== null), error: null }
}

/**
 * The wallet arm in ONE read: per-player totals (most ASP first) AND the cheapest
 * next pack per player (cheapest first), with whole-wallet counts. jsonb, so
 * PostgREST's 1,000-row clamp on set-returning RPCs cannot truncate it silently.
 */
export async function fetchTradeInWallet(
  db: TradeInBoardClient,
  wallet: string,
  limit: number = PORTFOLIO_PLAYERS,
): Promise<{ data: TradeInWallet | null; error: { message?: string } | null }> {
  const { data, error } = await db.rpc("get_topshot_trade_in_wallet", { p_wallet: wallet, p_limit: limit })
  if (error) return { data: null, error }
  // A non-object answer is a failed read, never an empty wallet.
  if (!data || typeof data !== "object" || Array.isArray(data)) return { data: null, error: { message: "unexpected wallet read shape" } }
  const j = data as Record<string, unknown>
  const totalPlayers = num(j.total_players)
  if (totalPlayers == null) return { data: null, error: { message: "unexpected wallet read shape" } }
  const players = (Array.isArray(j.players) ? (j.players as Array<Record<string, unknown>>) : [])
    .map((r) => normalizePortfolioRow(r, totalPlayers))
    .filter((r): r is TradeInPortfolioRow => r !== null)
  const nextPack = (Array.isArray(j.next_pack) ? (j.next_pack as unknown[]) : [])
    .map(normalizeFill)
    .filter((r): r is TradeInFill => r !== null)
  return {
    data: {
      wallet: str(j.wallet) ?? wallet,
      total_players: totalPlayers,
      players_with_fill: num(j.players_with_fill) ?? 0,
      players,
      next_pack: nextPack,
    },
    error: null,
  }
}
