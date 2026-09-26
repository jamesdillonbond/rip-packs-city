// lib/insights/panini-more-boards.ts
//
// The four Panini WC Prizm boards that were BUILT but never surfaced — deals,
// pack EV, special serials, players — assembled into ONE snapshot payload for the
// tabs under /insights/panini-squeeze (Trevor, 2026-09-25: "All four").
//
// ── WHY THEY WERE HELD, AND WHAT CHANGED ────────────────────────────────────
// 2026-07-19 they were deliberately NOT surfaced: every one reads the same
// LISTING-GATED index (Panini publishes no checklist; a card is known only once
// it has been listed), and surfacing them would "multiply one completeness
// defect across five more public boards". That gap is unchanged (pct_trustworthy
// ~35%), so it is DISCLOSED on every tab rather than resolved — the payload
// carries the coverage row and the client renders it above each board.
//
// ── WHY A SNAPSHOT, WARMED HOURLY ───────────────────────────────────────────
// Measured 2026-09-25: panini_deal_board ~3 s / 86k buffers (a seq scan of
// panini_card_serials), panini_player_board ~0.5 s / 158k buffers, special
// serials ~0.2 s / 26k. Run per anonymous render that is a disk-IO bill this
// estate has paid before; run on the 5-minute warm cron it is ~290 GB of buffer
// traffic a day. The data only moves on Panini's ~4-hourly walk, so the board is
// warmed HOURLY (`warmEveryMs` in WARM_BOARDS) and served from the snapshot.
//
// ── HONESTY ────────────────────────────────────────────────────────────────
//   · Each board carries its own `*_error` flag: a failed read is "couldn't
//     load", never "no deals".
//   · `ok` (cache the payload) requires EVERY board read to succeed — a partial
//     payload is never cached, so a stale-but-complete snapshot wins.
//   · `owner` (a Panini username) is not selected: nothing on these boards needs
//     a person's handle.
//   · A capped board says it is capped (`*_capped`) so "top 200" never reads as
//     "all of them".

import { supabaseAdmin } from "@/lib/supabase"
import { summarizeDegraded, type BoardStatus } from "@/lib/insights/board-status"
import type { BoardLiveResult } from "@/lib/insights/board-cache"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export const PANINI_BOARD_LIMIT = 200

const DEAL_COLS =
  "sku,player_name,parallel,tier,serial_number,mint_cap,ask_usd,best_offer_usd,last_sale_usd,fmv_usd," +
  "discount_pct,est_profit_usd,special_flag,ask_confirmed_at,recent_sales_median_usd,recent_sales_n,deal_basis"
const PACK_COLS =
  "pack_type,pack_cost_usd,floor_usd,avg_sale_usd,recent_sale_usd,cards_per_pack,packs_total,packs_remaining," +
  "packs_ripped_pct,actual_ev_usd,typical_ev_usd,net_rip_edge_usd,model_note,updated_at"
const SPECIAL_COLS =
  "sku,player_name,parallel,serial_number,mint_cap,headline_flag,all_flags,serial_ask_usd,serial_fmv_usd," +
  "edition_fmv_usd,last_sale_usd,last_sale_at,ask_confirmed_at"
const PLAYER_COLS =
  "player_name,editions,chases,rookie_editions,sealed_in_packs,top_fmv_usd,catalog_fmv_usd,sealed_fmv_exposure_usd,avg_rip_pct"

interface Read<T> {
  rows: T[] | null
  error: string | null
}

async function read<T>(q: PromiseLike<{ data: T[] | null; error: { message: string } | null }>, label: string): Promise<Read<T>> {
  try {
    const { data, error } = await q
    if (error) {
      console.error(`[panini-more-boards] ${label}:`, error.message)
      return { rows: null, error: `${label}: ${error.message}` }
    }
    return { rows: data ?? [], error: null }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[panini-more-boards] ${label} threw:`, msg)
    return { rows: null, error: `${label}: ${msg}` }
  }
}

export async function fetchPaniniMoreBoards(
  db: Db = supabaseAdmin,
): Promise<BoardLiveResult<Record<string, unknown>>> {
  const [deals, packs, specials, players, coverage, specialCount] = await Promise.all([
    read(
      db.from("panini_deal_board").select(DEAL_COLS)
        .order("est_profit_usd", { ascending: false })
        .order("sku", { ascending: true })
        .limit(PANINI_BOARD_LIMIT),
      "panini_deal_board",
    ),
    read(db.from("panini_pack_ev_board").select(PACK_COLS).order("pack_type", { ascending: true }), "panini_pack_ev_board"),
    read(
      db.from("panini_special_serials_board").select(SPECIAL_COLS)
        .eq("is_listed", true)
        .eq("ask_unconfirmed", false)
        .order("serial_fmv_usd", { ascending: false, nullsFirst: false })
        .order("sku", { ascending: true })
        .limit(PANINI_BOARD_LIMIT),
      "panini_special_serials_board",
    ),
    read(
      db.from("panini_player_board").select(PLAYER_COLS)
        // By indexed EDITIONS, not catalog FMV: that sum includes ask-derived FMV
        // on cards that never traded, so one high ask could top the board.
        .order("editions", { ascending: false, nullsFirst: false })
        .order("player_name", { ascending: true })
        .limit(PANINI_BOARD_LIMIT),
      "panini_player_board",
    ),
    read(
      db.from("panini_coverage_summary").select("total_editions,pct_trustworthy,edition_age_p50_h").limit(1),
      "panini_coverage_summary",
    ),
    // How many special serials exist and how many are listed with a confirmed ask,
    // so the tab can say "top 200 of N" instead of implying 200 is all of them.
    (async (): Promise<{ total: number | null; listed: number | null; error: string | null }> => {
      try {
        const [t, l] = await Promise.all([
          db.from("panini_special_serials_board").select("sku", { count: "exact", head: true }),
          db.from("panini_special_serials_board").select("sku", { count: "exact", head: true })
            .eq("is_listed", true).eq("ask_unconfirmed", false),
        ])
        if (t.error || l.error || t.count == null || l.count == null) {
          return { total: null, listed: null, error: (t.error ?? l.error)?.message ?? "count unavailable" }
        }
        return { total: t.count, listed: l.count, error: null }
      } catch (e) {
        return { total: null, listed: null, error: e instanceof Error ? e.message : String(e) }
      }
    })(),
  ])

  const statuses: BoardStatus[] = [
    { label: "Deals", ok: deals.error === null, partial: false },
    { label: "Pack EV", ok: packs.error === null, partial: false },
    { label: "Special serials", ok: specials.error === null, partial: false },
    { label: "Players", ok: players.error === null, partial: false },
  ]
  const errors = [deals, packs, specials, players, coverage].map((r) => r.error).filter(Boolean) as string[]
  if (specialCount.error) errors.push(`special serial counts: ${specialCount.error}`)

  return {
    payload: {
      deals: deals.rows,
      deals_error: deals.error !== null,
      deals_capped: (deals.rows?.length ?? 0) >= PANINI_BOARD_LIMIT,
      packs: packs.rows,
      packs_error: packs.error !== null,
      specials: specials.rows,
      specials_error: specials.error !== null,
      specials_total: specialCount.total,
      specials_listed: specialCount.listed,
      players: players.rows,
      players_error: players.error !== null,
      players_capped: (players.rows?.length ?? 0) >= PANINI_BOARD_LIMIT,
      coverage: coverage.rows?.[0] ?? null,
      degraded: summarizeDegraded(statuses),
      fetchedAt: new Date().toISOString(),
    },
    // Cache only a COMPLETE payload; a stale-but-complete snapshot beats a
    // fresh one with a board missing.
    ok: errors.length === 0,
    rowCount: deals.rows?.length ?? null,
    error: errors.length ? errors.join("; ").slice(0, 500) : undefined,
  }
}
