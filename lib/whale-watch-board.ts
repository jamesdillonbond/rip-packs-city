// lib/whale-watch-board.ts
//
// Shared fetch + shape for the public Whale Watch board (/insights/whales,
// 2026-11-27). Trevor: "a whale watcher page" — who is spending big, across every
// collection we track.
//
// WHO COUNTS AS A WHALE: any buyer of one of a collection's 25 biggest sales in a
// Pacific-time month ($100 minimum; items and packs ranked separately), from
// public.big_spender_wallets. Once a buyer qualifies they stay tracked.
//
// WHERE THE NUMBERS COME FROM: public.whale_watch_board, ONE jsonb row written
// hourly by refresh_whale_watch_board() (pg_cron rpc-whale-watch-board). Reading the
// activity live costs ~32 s over 30 days, so the page never computes it. The table
// is service_role only; the server page and /api/public/insights/whales read it
// through supabaseAdmin, so no address-bearing object is exposed to anon.
//
// Since the 20261128013007 follow-up every leader and move also carries `key` (the wallet
// key or Panini username) so the page links a whale to that collection's wallet page, every
// leader carries `top_collection`, and `by_collection` holds each collection's own top 10.
//
// What the board counts: BUYS only. Trades between two wallets that have each
// bought a top sale FROM the other are left out, so cards changing hands back and
// forth inside a pair do not read as spend.

import { fromDbSlug } from "@/lib/collections"
import { topFanHref } from "@/lib/entity/top-fans-format"

export type WhaleWindow = "7d" | "30d"

export interface WhaleLeader {
  rank: number
  /** Marketplace username (Top Shot / Panini). Null when we have none — then `wallet` is set. */
  username: string | null
  chain: "flow" | "solana" | "panini"
  /** The raw wallet key, only when there is no username. */
  wallet: string | null
  buys: number
  pack_buys: number
  spent_usd: number
  biggest_usd: number
  /** DB collection slugs (nba_top_shot, panini_blockchain, …). */
  collections: string[]
  /** The DB slug of the collection they spent the most in, in this window. Null on an older snapshot. */
  top_collection: string | null
  /** Wallet key / Panini username, for the link. Null on an older snapshot. */
  key: string | null
  last_at: string
}

export interface WhaleMove {
  at: string
  collection: string
  kind: "item" | "pack"
  item: string | null
  price_usd: number
  username: string | null
  chain: "flow" | "solana" | "panini"
  wallet: string | null
  /** Wallet key / Panini username, for the link. Null on an older snapshot. */
  key: string | null
  edition_id: string | null
}

export interface WhaleWatchBoard {
  computed_at: string | null
  tracked_wallets: number
  active_7d: number
  spend_7d_usd: number
  new_tracked_7d: number
  leaders: Record<WhaleWindow, WhaleLeader[]>
  /** Per DB collection slug: that collection's own top spenders. Empty on an older snapshot. */
  by_collection: Record<string, Record<WhaleWindow, WhaleLeader[]>>
  moves: WhaleMove[]
  biggest_30d: WhaleMove[]
}

export const EMPTY_WHALE_BOARD: WhaleWatchBoard = {
  computed_at: null,
  tracked_wallets: 0,
  active_7d: 0,
  spend_7d_usd: 0,
  new_tracked_7d: 0,
  leaders: { "7d": [], "30d": [] },
  by_collection: {},
  moves: [],
  biggest_30d: [],
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Shape one raw jsonb board. Exported for tests. */
export function shapeWhaleBoard(raw: any, computedAt: string | null): WhaleWatchBoard {
  const leaders = (rows: any): WhaleLeader[] =>
    Array.isArray(rows)
      ? rows.map((r: any) => ({
          rank: num(r.rank),
          username: typeof r.username === "string" && r.username ? r.username : null,
          chain: r.chain === "solana" || r.chain === "panini" ? r.chain : "flow",
          wallet: typeof r.wallet === "string" && r.wallet ? r.wallet : null,
          buys: num(r.buys),
          pack_buys: num(r.pack_buys),
          spent_usd: num(r.spent_usd),
          biggest_usd: num(r.biggest_usd),
          collections: Array.isArray(r.collections) ? r.collections.filter((c: unknown) => typeof c === "string") : [],
          top_collection: typeof r.top_collection === "string" && r.top_collection ? r.top_collection : null,
          key: typeof r.key === "string" && r.key ? r.key : null,
          last_at: String(r.last_at ?? ""),
        }))
      : []
  const moves = (rows: any): WhaleMove[] =>
    Array.isArray(rows)
      ? rows.map((r: any) => ({
          at: String(r.at ?? ""),
          collection: String(r.collection ?? ""),
          kind: r.kind === "pack" ? "pack" : "item",
          item: typeof r.item === "string" && r.item ? r.item : null,
          price_usd: num(r.price_usd),
          username: typeof r.username === "string" && r.username ? r.username : null,
          chain: r.chain === "solana" || r.chain === "panini" ? r.chain : "flow",
          wallet: typeof r.wallet === "string" && r.wallet ? r.wallet : null,
          key: typeof r.key === "string" && r.key ? r.key : null,
          edition_id: typeof r.edition_id === "string" && r.edition_id ? r.edition_id : null,
        }))
      : []
  const byCollection = (obj: any): Record<string, Record<WhaleWindow, WhaleLeader[]>> => {
    const out: Record<string, Record<WhaleWindow, WhaleLeader[]>> = {}
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out
    for (const [slug, v] of Object.entries(obj as Record<string, any>)) {
      out[slug] = { "7d": leaders(v?.["7d"]), "30d": leaders(v?.["30d"]) }
    }
    return out
  }
  return {
    computed_at: computedAt ?? (typeof raw?.computed_at === "string" ? raw.computed_at : null),
    tracked_wallets: num(raw?.tracked_wallets),
    active_7d: num(raw?.active_7d),
    spend_7d_usd: num(raw?.spend_7d_usd),
    new_tracked_7d: num(raw?.new_tracked_7d),
    leaders: { "7d": leaders(raw?.leaders?.["7d"]), "30d": leaders(raw?.leaders?.["30d"]) },
    by_collection: byCollection(raw?.by_collection),
    moves: moves(raw?.moves),
    biggest_30d: moves(raw?.biggest_30d),
  }
}

/**
 * Read the precomputed board. THROWS on a failed read AND on a missing row — the
 * snapshot is written hourly, so "no row" means the writer never ran, which is
 * not the same answer as "nobody bought anything" and must not render as one.
 */
export async function fetchWhaleWatchBoard(db: any): Promise<WhaleWatchBoard> {
  const { data, error } = await db.from("whale_watch_board").select("board, computed_at").eq("id", 1).maybeSingle()
  if (error) throw new Error(`whale_watch_board: ${error.message}`)
  if (!data?.board) throw new Error("whale_watch_board: no snapshot has been written")
  return shapeWhaleBoard(data.board, typeof data.computed_at === "string" ? data.computed_at : null)
}

/**
 * The name a whale goes by on the page. A username when we have one; otherwise a
 * shortened wallet — marked with "…" so nobody reads it as a username. Never a
 * folded or prefixed address (a Solana key is case-sensitive and un-prefixed).
 */
export function whaleName(w: { username: string | null; wallet: string | null }): string {
  if (w.username) return w.username
  if (!w.wallet) return "—"
  const k = w.wallet
  if (k.length <= 12) return k
  return k.startsWith("0x") ? `${k.slice(0, 6)}…${k.slice(-4)}` : `${k.slice(0, 4)}…${k.slice(-4)}`
}

const COLLECTION_LABEL: Record<string, string> = {
  nba_top_shot: "Top Shot",
  nfl_all_day: "All Day",
  laliga_golazos: "Golazos",
  disney_pinnacle: "Pinnacle",
  ufc_strike: "UFC Strike",
  candy_mlb: "Candy MLB",
  panini_blockchain: "Panini",
}

export function whaleCollectionLabel(dbSlug: string): string {
  return COLLECTION_LABEL[dbSlug] ?? dbSlug
}

/** Display order for the collection filter chips. */
export const WHALE_COLLECTION_ORDER = [
  "nba_top_shot",
  "nfl_all_day",
  "panini_blockchain",
  "candy_mlb",
  "disney_pinnacle",
  "laliga_golazos",
  "ufc_strike",
] as const

/**
 * Where a whale's name links: that collection's anon-public wallet page, via the same
 * helper Top Fans uses (Panini owners are usernames → ?username=). Null when we lack the
 * key or the collection — then the name renders as plain text, never a broken link.
 */
export function whaleHref(dbSlug: string | null, key: string | null): string | null {
  if (!dbSlug || !key) return null
  const urlSlug = fromDbSlug(dbSlug)
  return urlSlug ? topFanHref(urlSlug, key) : null
}
