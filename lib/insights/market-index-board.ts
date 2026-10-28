// lib/insights/market-index-board.ts
//
// The one read behind the RPC Index — shared by both boards' server pages (/insights/market, /insights/allday-market)
// and /api/public/insights/market (the OG cards' source), so all three read the same view the same way.
// Extracted 2026-10-28 when NFL All Day joined; the query is the one both Top Shot copies carried, unchanged.
//
// ⚠ PAGED + BOUNDED: PostgREST clamps a .limit() above 1,000, and the sort is d ASCENDING, so a clamped read would
// drop the NEWEST days off an index chart while keeping stale history. And both pages are PRERENDERED — an unbounded
// read here failed a production build on 2026-08-15 — hence withPagedBoardBudget.

import { supabaseAdmin } from "@/lib/supabase"
import { fetchAllPaged } from "@/lib/supabase-paginate"
import { withPagedBoardBudget } from "@/lib/insights/board-page-fetch"
import { marketIndexConfig, type MarketIndexCollection } from "@/lib/insights/market-index-collections"

export type MarketIndexRow = {
  d: string
  tier: string
  sales: number | string | null
  volume_usd: number | string | null
  median_px: number | string | null
  avg_px: number | string | null
  max_px: number | string | null
}

export async function fetchMarketIndexRows(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  opts: { collection: MarketIndexCollection; days?: number; tier?: string | null; label: string },
): Promise<{ rows: MarketIndexRow[]; error: unknown }> {
  const days = Math.max(1, Math.min(120, opts.days ?? 120))
  // Trailing-window cutoff (inclusive). The view holds ~120 days.
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  const view = marketIndexConfig(opts.collection).view
  const { rows, error } = await withPagedBoardBudget(
    fetchAllPaged<MarketIndexRow>(
      (from, to) => {
        let q = db
          .from(view)
          .select("d, tier, sales, volume_usd, median_px, avg_px, max_px")
          .gte("d", cutoff)
          .order("d", { ascending: true })
          .order("tier", { ascending: true })
          .range(from, to)
        if (opts.tier) q = q.eq("tier", opts.tier)
        return q
      },
      { label: opts.label },
    ),
    "market",
  )
  return { rows: (rows ?? []) as MarketIndexRow[], error }
}

/**
 * A board page's server read. ⚠ HONESTY: a failed read is NOT "no data" — returning [] rendered "No market data in
 * range." on a healthy market (the 2026-08-01 QA sweep, while the view was timing out). `loadError` set means the
 * board says it is broken, and the page stamps no freshness time.
 */
export async function fetchMarketIndexPageRows(collection: MarketIndexCollection): Promise<{ rows: MarketIndexRow[]; loadError: string | null }> {
  const { rows, error } = await fetchMarketIndexRows(supabaseAdmin, { collection, label: `insights/${collection === "nfl-all-day" ? "allday-market" : "market"}` })
  if (error) {
    console.error("[insights/market] initial fetch", collection, error)
    return { rows: [], loadError: String(error) || "market index unavailable" }
  }
  return { rows, loadError: null }
}
