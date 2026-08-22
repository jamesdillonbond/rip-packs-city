// Shared DEFAULT-view builder for the Panini WC Prizm squeeze public board.
//
// panini-squeeze is the PAGINATED board: it fetches the WHOLE panini_squeeze_board
// (ORDER BY fmv_usd DESC) in .range() pages because the client filters over the full
// set, plus two single-row summary fetches (coverage + totals). It is the "sharper"
// failure case — a page-3-of-N timeout returns the top ~1,800 rows and renders them
// as though they were the whole ranking, so a truncated fetch is a CORRUPTED ranking,
// not merely an incomplete one.
//
// Therefore the warm gate here is STRICTER than candy-mlb's: `ok` requires a COMPLETE
// page-set (every page fetched, no truncation). We never cache a partial ranking — a
// complete-but-stale board beats a fresh-but-truncated one, and the board's data moves
// slowly (a residential runner refreshes every ~4h in rotation). Coverage/totals have
// their own honest fallbacks (no banner / slice-derived KPIs) and do not corrupt the
// ranking, so they never block the warm. Shared by the page (readBoardOrLive) and the
// cron (warmBoard). `db` defaults to supabaseAdmin but is injectable for tests.

import { supabaseAdmin } from "@/lib/supabase"
import { readMvAsOf } from "@/lib/insights/mv-freshness"
import { summarizeDegraded, type BoardStatus } from "@/lib/insights/board-status"
import type { BoardLiveResult } from "@/lib/insights/board-cache"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

const COLS =
  "player_name,set_name,tier,mint_cap,pulled_count,still_in_packs,rip_pct,fmv_usd,sealed_fmv_exposure_usd,serial_low_ask_usd,is_rookie,is_debut,serials_with_recorded_price,coverage_flag,fmv_confidence"

const PAGE = 1000
const MAX_PAGES = 10 // hard stop so a runaway view can never spin the request

async function fetchRows(
  db: Db
): Promise<{ rows: any[]; ok: boolean; partial: boolean; error?: string }> {
  const all: any[] = []
  for (let p = 0; p < MAX_PAGES; p++) {
    const { data, error } = await db
      .from("panini_squeeze_board")
      .select(COLS)
      .not("fmv_usd", "is", null)
      .order("fmv_usd", { ascending: false })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) {
      console.error("[panini-squeeze] backing view error:", error.message)
      // Carry the reason out, not just the fact. The sibling boards name their
      // driver text in pipeline_runs; a fixed "query failed" here would leave the
      // one board whose failure is NOT known to be a timeout as the only one you
      // still cannot diagnose from the pipeline row. Page index included because a
      // failure on page 0 and a failure on page 8 are different problems.
      return { rows: all, ok: false, partial: all.length > 0, error: `page ${p}: ${error.message}` }
    }
    const batch = data ?? []
    all.push(...batch)
    // A short page is the natural end of the set — that is the ONLY complete exit.
    if (batch.length < PAGE) return { rows: all, ok: true, partial: false }
  }
  // Fell out of the loop with every page full: the ranking is cut off at
  // MAX_PAGES * PAGE and there are more rows we never fetched.
  //
  // ⚠ This used to return `partial: false`, i.e. a TRUNCATED ranking reported as
  // COMPLETE — the exact thing this file's own comment calls "a CORRUPTED ranking,
  // not merely a short one". The `partial` flag existed to prevent it but only ever
  // covered the ERROR exit, never the cap exit: one way of failing modelled, the
  // other not. Same shape as the ladder that fell back on an errored query but not
  // a slow one.
  //
  // Not reachable today (cap 10,000 vs ~4,500 rows on the board, measured
  // 2026-08-12) — which is precisely why it would have gone unnoticed when the
  // Panini runner's discovery eventually crosses it. Reported, not silently served.
  return { rows: all, ok: true, partial: true }
}

async function fetchCoverage(db: Db): Promise<any> {
  const { data, error } = await db
    .from("panini_coverage_summary")
    .select(
      "total_editions,trustworthy_editions,pct_trustworthy,listing_gated_editions,listing_gated_families,families," +
        "best_family_checklist_pct,worst_family_checklist_pct,checklist_players_seen,checklist_players_new_24h," +
        "oldest_family_refresh_h,newest_family_refresh_h"
    )
    .limit(1)
  if (error) {
    console.error("[panini-squeeze] coverage summary error:", error.message)
    return null
  }
  return data?.[0] ?? null
}

async function fetchTotals(db: Db): Promise<any> {
  const { data, error } = await db
    .from("panini_squeeze_totals")
    .select(
      "editions,sealed_fmv_exposure_usd,chases_lte_25,sealed_copies," +
        "editions_hc,sealed_fmv_exposure_usd_hc,sealed_copies_hc,pct_sealed_usd_from_biased_sets"
    )
    .limit(1)
  if (error) {
    console.error("[panini-squeeze] totals error:", error.message)
    return null
  }
  return data?.[0] ?? null
}

/**
 * Assemble the full default Panini squeeze board payload. `ok` requires a COMPLETE
 * page-set (see the header) — a partial/truncated fetch is never cached, because this
 * board is a ranking and a truncated ranking is wrong, not merely short. The
 * `degraded` roll-up still travels in the payload for the live/stale render path.
 */
export async function fetchPaniniSqueezeDefault(
  db: Db = supabaseAdmin
): Promise<BoardLiveResult<Record<string, unknown>>> {
  const [rows, coverage, totals, dataAsOf] = await Promise.all([
    fetchRows(db),
    fetchCoverage(db),
    fetchTotals(db),
    // ⚠ Materialized 2026-08-22, so fetchedAt (when WE asked) and the age of the rows are
    // no longer the same thing. null = cannot tell, never now(). See mv-freshness.ts.
    readMvAsOf("panini-squeeze", db as never),
  ])

  // ⚠ `ok` here must be "usable", NOT "the query succeeded" — summarizeDegraded
  // skips any status with `ok: true` (`if (s.ok) continue`), so a page-capped read
  // (which returns ok:true, partial:true) would emit NO notice while the payload
  // below empties its rows: a blank board with nothing explaining it, i.e. exactly
  // the "empty reads as 'nothing matched'" defect this whole module exists to
  // prevent. Introduced by my own cap fix earlier today and caught by asking what
  // the READER sees rather than what the function returns.
  const status: BoardStatus = {
    label: "Squeeze board",
    ok: rows.ok && !rows.partial,
    partial: rows.partial,
  }

  return {
    payload: {
      // A truncated ranking is a CORRUPTED ranking, not merely a short one. The warm
      // gate below (ok = complete) already stops a partial set from ever being cached —
      // but board-cache's `live-degraded` rung (no snapshot exists AND live failed, e.g.
      // during a long saturation spell after a cache reset) hands this payload back
      // VERBATIM. So the rows must be emptied HERE for the strict gate to hold
      // end-to-end: for a ranking, no-data is honest and partial-data is a lie. The
      // `degraded` notice still travels, so the render explains the empty board.
      initialRows: rows.partial ? [] : rows.rows,
      coverage,
      totals,
      degraded: summarizeDegraded([status]),
      fetchedAt: new Date().toISOString(),
      dataAsOf,
    },
    ok: rows.ok && !rows.partial, // complete board only — never cache a truncated ranking
    rowCount: rows.rows.length,
    // Telemetry only. The two ways this board declines to cache are DIFFERENT
    // failures and were previously indistinguishable in pipeline_runs: the view
    // errored, versus the view worked but paged out mid-ranking (partial). The
    // second is the one that needs MAX_PAGES revisited, so name it.
    error: rows.ok
      ? rows.partial
        ? `panini_squeeze_board: partial ranking (${rows.rows.length} rows, hit the ${MAX_PAGES}-page cap)`
        : undefined
      : `panini_squeeze_board: ${rows.error ?? "query failed"}`,
  }
}
