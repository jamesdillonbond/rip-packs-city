// Shared DEFAULT-view builders for the cached public /insights boards.
//
// Each function reproduces EXACTLY the default query the board's server page used to
// run inline (same view, columns, order, limit) and returns the JSON payload that
// page hands to its client, plus an `ok` flag (true only when every backing query
// succeeded — an errored fetch must never be cached). These are the single source of
// the default payload, shared by:
//   - the server pages (app/insights/<board>/page.tsx) via readBoardOrLive()
//   - the cron (/api/cron/refresh-insights-cache) via warmBoard()
// so the query lives in one place instead of being duplicated across page + cron.
//
// The `db` param defaults to supabaseAdmin but is injectable for unit tests.

import { supabaseAdmin } from "@/lib/supabase"
import { readMvAsOf } from "@/lib/insights/mv-freshness"
import type { BoardLiveResult } from "@/lib/insights/board-cache"
import { describeBoardFailures } from "@/lib/insights/board-cache"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

const DEALS_COLS =
  "external_id, name, player_name, set_name, tier, circulation_count, fmv_usd, confidence, low_ask, discount_pct, discount_usd, ask_updated_at, collection_slug, collection_name, render_id, detail_url, thumbnail_url, low_confidence_fmv"

/** Below FMV board default view: discount_pct >= 10, biggest discount first, top 200. */
export async function fetchDealsDefault(
  db: Db = supabaseAdmin
): Promise<BoardLiveResult<{ rows: unknown[]; fetched_at: string; data_as_of: string | null }>> {
  const { data, error } = await db
    .from("cross_collection_deals_board")
    .select(DEALS_COLS)
    .gte("discount_pct", 10)
    .order("discount_pct", { ascending: false })
    .limit(200)
  const rows = (data ?? []) as unknown[]
  // ⚠ `fetched_at` is when WE asked; `data_as_of` is how old the rows actually are.
  // Since 2026-08-22 this board reads a materialized view, so those are no longer the same
  // thing and only the second one answers "is this deal still live?". null = cannot tell,
  // NEVER now() — see lib/insights/mv-freshness.ts.
  const dataAsOf = await readMvAsOf("deals", db as never)
  return {
    payload: { rows, fetched_at: new Date().toISOString(), data_as_of: dataAsOf },
    ok: !error,
    rowCount: rows.length,
    error: describeBoardFailures([
      { label: "cross_collection_deals_board", ok: !error, error: error?.message },
    ]),
  }
}

/** 2025 Rookie Index default view: cohort stats + GMV-ranked rows, top 100. */
export async function fetchRookiesDefault(
  db: Db = supabaseAdmin
): Promise<
  BoardLiveResult<{ meta: { fetched_at: string }; cohort_stats: unknown; rows: unknown[] }>
> {
  const [statsRes, indexRes] = await Promise.all([
    db.from("topshot_2025_rookie_cohort_stats").select("*").limit(1),
    db
      .from("topshot_2025_rookie_index")
      .select("*")
      .order("gmv_30d", { ascending: false, nullsFirst: false })
      .limit(100),
  ])
  const rows = (indexRes.data ?? []) as unknown[]
  return {
    payload: {
      meta: { fetched_at: new Date().toISOString() },
      cohort_stats: statsRes.data?.[0] ?? null,
      rows,
    },
    ok: !statsRes.error && !indexRes.error,
    rowCount: rows.length,
    error: describeBoardFailures([
      { label: "topshot_2025_rookie_cohort_stats", ok: !statsRes.error, error: statsRes.error?.message },
      { label: "topshot_2025_rookie_index", ok: !indexRes.error, error: indexRes.error?.message },
    ]),
  }
}

const TROPHY_COLS =
  "edition_id, external_id, player_name, set_name, tier, circulation_count, mint_one_sold_at, mint_one_price_usd, avg_other_serial_price_usd, other_serial_sample_n, multiplier"

/** First-Mint Trophy Tracker default view: cohort stats + multiplier-ranked, top 100. */
export async function fetchFirstMintDefault(
  db: Db = supabaseAdmin
): Promise<
  BoardLiveResult<{
    meta: { fetched_at: string; data_as_of: string | null }
    stats: unknown
    trophies: unknown[]
  }>
> {
  const [statsRes, trophiesRes] = await Promise.all([
    db.from("topshot_first_mint_trophy_stats").select("*").limit(1),
    db
      .from("topshot_first_mint_trophies")
      .select(TROPHY_COLS)
      .order("multiplier", { ascending: false, nullsFirst: false })
      .limit(100),
  ])
  const trophies = (trophiesRes.data ?? []) as unknown[]
  // Materialized 2026-08-22 — see the deals comment above and mv-freshness.ts.
  const dataAsOf = await readMvAsOf("first-mint", db as never)
  return {
    payload: {
      meta: { fetched_at: new Date().toISOString(), data_as_of: dataAsOf },
      stats: statsRes.data?.[0] ?? null,
      trophies,
    },
    ok: !statsRes.error && !trophiesRes.error,
    rowCount: trophies.length,
    error: describeBoardFailures([
      { label: "topshot_first_mint_trophy_stats", ok: !statsRes.error, error: statsRes.error?.message },
      { label: "topshot_first_mint_trophies", ok: !trophiesRes.error, error: trophiesRes.error?.message },
    ]),
  }
}
