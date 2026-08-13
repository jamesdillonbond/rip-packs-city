// Shared DEFAULT-view builder for the Candy MLB public insights board.
//
// candy-mlb is a MULTI-SECTION board: its server page fetches 10 backing views in
// parallel. It is the board with MEASURED production timeouts (one render logged SIX
// simultaneous 57014s, 2026-08-09), so it is the highest-value target for the
// PUBLIC-BOARD-CACHING (nc1) work. This module reproduces the page's exact assembly
// (same views, columns, order, limits) and returns the full CandyBoardClient payload
// plus an `ok` flag that is true ONLY when every section succeeded — so the cron
// caches a fully-healthy board and never overwrites the last-good full snapshot with
// a partially-degraded one. Under saturation the page then serves that last-good
// snapshot instead of timing out. Shared by the page (readBoardOrLive) and the cron
// (warmBoard). `db` defaults to supabaseAdmin but is injectable for tests.

import { supabaseAdmin } from "@/lib/supabase"
import { summarizeDegraded, type BoardStatus } from "@/lib/insights/board-status"
import type { BoardLiveResult } from "@/lib/insights/board-cache"
import { describeBoardFailures } from "@/lib/insights/board-cache"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

const MARKET_COLS =
  "external_id,player_name,edition_name,tier,is_rainbow,circulation_count,fmv_usd,fmv_computed_at," +
  "last_sale_serial,median_sale_usd," +
  "sales_24h,sales_7d,sales_all,last_sale_at,last_sale_usd,best_offer_usd,offer_bidders,floor_ask_usd,listing_count,excluded_troll_count"

async function fetchView(
  db: Db,
  view: string,
  cols: string,
  orderCol: string,
  asc = false,
  limit = 600
): Promise<{ rows: any[]; ok: boolean; truncated: boolean }> {
  const { data, error } = await db
    .from(view)
    .select(cols)
    .order(orderCol, { ascending: asc, nullsFirst: false })
    .limit(limit)
  if (error) {
    console.error(`[candy-mlb] ${view} error:`, error.message)
    return { rows: [] as any[], ok: false, truncated: false }
  }
  const rows = (data ?? []) as any[]
  // Every one of these views is ORDERED, so a hard `.limit()` that fills exactly is
  // a TRUNCATED RANKING served as the complete set — the same defect just fixed on
  // panini's page cap, one layer up. Nothing errors, every row on screen is correct,
  // and the board simply stops.
  //
  // ⚠ Not theoretical any more. Measured live 2026-08-12, rows against each call's
  // OWN limit (they differ — do not assume the 600 default):
  //   candy_special_serials_board  607 / 800   ← tightest, 1.32x
  //   candy_holder_board           395 / 800
  //   candy_player_board           100 / 600
  //   secondary / deals / spread / scarcity  ~125 / 600
  //   candy_parallel_premium         2 / 5     (semantically bounded: parallel groups)
  // CLAUDE.md recorded the serials board at 500 rows and 246 collectors when those
  // caps were chosen — +21% and +61% since. Both grow with every Candy drop, and
  // nothing today is at its cap, so this reports rather than cries wolf.
  //
  // ⚠ This does NOT gate the cache (`ok` stays true): unlike panini's ranking, a
  // large top-N slice is still useful, and blanking a tab because it filled its cap
  // would be a far bigger behaviour change than the problem. It is reported instead —
  // which is also what keeps the client's "Showing N of M" honest, since M is the
  // fetched length and would silently become the cap.
  return { rows, ok: true, truncated: rows.length >= limit }
}

async function fetchOne(
  db: Db,
  view: string,
  cols: string
): Promise<{ row: any; ok: boolean; truncated: boolean }> {
  const { data, error } = await db.from(view).select(cols).limit(1)
  if (error) {
    console.error(`[candy-mlb] ${view} error:`, error.message)
    return { row: null, ok: false, truncated: false }
  }
  // A single-row summary fetch cannot be truncated in the meaningful sense — the
  // field exists so every section has the same shape below.
  return { row: data?.[0] ?? null, ok: true, truncated: false }
}

/**
 * Assemble the full default Candy MLB board payload.
 *
 * `ok` gates on the PRIMARY Market section only, NOT on all 10 sections. Live
 * evidence (2026-08-09): under sustained saturation even the single-view boards warm
 * only ~1 per tick, so an all-10-healthy gate would almost never be satisfiable
 * exactly when this board — the one with the measured six-timeout render — most needs
 * a cached copy to serve. Gating on Market means the board caches during the common
 * partial-saturation windows too; the per-section health travels in `payload.degraded`
 * so a served snapshot with a degraded peripheral section stays honest (and is at most
 * BOARD_CACHE_FRESH_MS stale). A total Market failure (no headline data) is the one
 * case we refuse to cache — the page then serves the last-good snapshot or live.
 */
export async function fetchCandyMlbDefault(
  db: Db = supabaseAdmin
): Promise<BoardLiveResult<Record<string, unknown>>> {
  const [rows, packEv, packMarket, deals, spreads, serials, scarcity, holders, players, parallel] =
    await Promise.all([
      fetchView(db, "candy_secondary_board", MARKET_COLS, "fmv_usd"),
      fetchOne(
        db,
        "candy_pack_ev_model",
        "icon_slots,rainbow_chance,pack_cost_usd,common_slot_ev,common_slot_typical,rainbow_ev," +
          "common_total,common_priced,rainbow_total,rainbow_priced,actual_ev_usd,typical_pull_ev_usd,model_note"
      ),
      fetchOne(
        db,
        "candy_pack_market",
        "pack_assets_indexed,collector_held,collector_wallets,active_asks,floor_ask_usd," +
          "sales_all,sales_7d,median_7d_usd,last_sale_usd,last_sale_at," +
          "retail_usd,median_vs_retail_x,median_vs_typical_pull_x,median_vs_actual_ev_x"
      ),
      fetchView(
        db,
        "candy_deals_board",
        "pda_address,external_id,player_name,edition_name,tier,is_rainbow,circulation_count,serial_number,ask_usd,fmv_usd,discount_pct,discount_vs_median_pct,median_sale_usd,sales_count,seller",
        "discount_pct"
      ),
      fetchView(
        db,
        "candy_offer_spread_board",
        // D33: `spread_usd`/`spread_pct` were DROPPED from the view — they
        // subtracted a mint-grain bid from an edition-grain ask, i.e. priced two
        // different NFTs. `same_copy` exposes that grain and `exec_spread_*` is
        // the executable replacement (floor copy only). Selecting the old names
        // here would now hard-fail the whole section, not silently return null.
        "external_id,player_name,edition_name,tier,is_rainbow,circulation_count,floor_usd,listing_count," +
          "best_offer_usd,distinct_bidders,fmv_usd,floor_mint,best_offer_mint,same_copy," +
          "floor_copy_bid_usd,exec_spread_usd,exec_spread_pct",
        "best_offer_usd"
      ),
      fetchView(
        db,
        "candy_special_serials_board",
        "external_id,player_name,edition_name,tier,is_rainbow,circulation_count,serial_number,kind,owner,is_treasury,fmv_usd,last_sale_usd,last_sale_at",
        "fmv_usd",
        false,
        800
      ),
      fetchView(
        db,
        "candy_scarcity_board",
        "external_id,player_name,edition_name,tier,is_rainbow,circulation_count,sealed,circulating,circulating_pct,holders,fmv_usd",
        "circulating_pct",
        true
      ),
      fetchView(
        db,
        "candy_holder_board",
        "wallet_address,serials,editions,est_fmv_usd,priced_serials",
        "serials",
        false,
        800
      ),
      fetchView(
        db,
        "candy_player_board",
        "player_name,team_name,editions,rainbow_editions,total_supply,priced,avg_fmv,top_fmv,sales_all",
        "top_fmv"
      ),
      fetchView(
        db,
        "candy_parallel_premium",
        "parallel_group,is_rainbow,editions,priced,avg_fmv,min_fmv,max_fmv,total_supply",
        "is_rainbow",
        true,
        5
      ),
    ])

  // ⚠ `ok` on a BoardStatus means "usable", not "the query succeeded":
  // summarizeDegraded skips any status with ok:true (`if (s.ok) continue`), so a
  // section that filled its `.limit()` must report ok:false + partial:true or it
  // renders a truncated ranking with no notice at all. Same semantics as panini's
  // Squeeze board status.
  const sections: BoardStatus[] = [
    ["Market", rows],
    ["Pack EV", packEv],
    ["Pack market", packMarket],
    ["Deals", deals],
    ["Offer spread", spreads],
    ["Serials", serials],
    ["Scarcity", scarcity],
    ["Holders", holders],
    ["Players", players],
    ["Parallels", parallel],
  ].map(([label, sec]: any) => ({
    label: label as string,
    ok: sec.ok && !sec.truncated,
    partial: sec.truncated,
  }))

  return {
    payload: {
      initialRows: rows.rows,
      packEv: packEv.row,
      packMarket: packMarket.row,
      deals: deals.rows,
      spreads: spreads.rows,
      serials: serials.rows,
      scarcity: scarcity.rows,
      holders: holders.rows,
      players: players.rows,
      parallel: parallel.rows,
      degraded: summarizeDegraded(sections),
      fetchedAt: new Date().toISOString(),
    },
    ok: rows.ok, // gate on the primary Market section (see doc comment above)
    rowCount: rows.rows.length,
    // Telemetry only. `ok` gates on Market alone, but a warm that succeeded with
    // three dead sections is worth seeing in pipeline_runs — so report EVERY failed
    // section, not just the gating one. (Candy already console.errors each view; this
    // is what puts the same information in the pipeline row an operator actually reads.)
    // `sec.ok` is already "usable", so a capped section lands here too — but it
    // must SAY which kind it is, because "the view is down" and "the view filled
    // its cap" need opposite responses (fix the query vs raise the limit).
    error: describeBoardFailures(
      sections.map((sec) => ({
        label: sec.label,
        ok: sec.ok,
        error: sec.partial ? "hit the row cap — ranking truncated" : null,
      }))
    ),
  }
}
