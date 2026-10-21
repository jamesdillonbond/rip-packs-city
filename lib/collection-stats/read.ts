// lib/collection-stats/read.ts
//
// The ONE read behind the collection overview's KPI band, shared by
// `/api/collection-stats` (the client's live refresh) and the overview page
// (the server-seeded FIRST render, review E2 2026-10-13: the five
// highest-authority pages used to paint their primary numbers only after a
// client fetch, so a crawler — and a visitor's first frame — saw em-dashes).
//
// Three outcomes, never collapsed: `ok` with the enriched payload; `not_found`
// (the RPC answered with its own `{error}` — an unknown slug); `unavailable`
// (the read FAILED — the caller must not publish anything in its place).
// Detail for the log is returned separately so neither caller leaks the
// driver's message (lib/api-error.ts contract).

import type { SupabaseClient } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase"
import { boundedRead } from "@/lib/api/bounded-read"
import { readPaniniCoverage } from "@/lib/panini/coverage"
import { readPaniniOverviewDeals, readPaniniTopSales, PANINI_TOP_SALES_DAYS, PANINI_TOP_SALES_MIN_USD } from "@/lib/panini/overview-feeds"

export type CollectionStatsRead =
  | { ok: true; stats: Record<string, unknown> }
  | { ok: false; kind: "not_found"; body: Record<string, unknown> }
  | { ok: false; kind: "unavailable"; error: unknown }

/** `nba-top-shot` → `nba_top_shot`: the RPC's slug vocabulary. */
export function normalizeStatsSlug(collection: string): string {
  return collection.replace(/-/g, "_")
}

export async function readCollectionStats(
  client: SupabaseClient,
  normalizedSlug: string,
  where: string,
): Promise<CollectionStatsRead> {
  try {
    const { data, error } = await boundedRead(
      (client as any).rpc("get_collection_stats", { p_slug: normalizedSlug }),
      where + "/get_collection_stats",
    )
    if (error) return { ok: false, kind: "unavailable", error }

    if (data && typeof data === "object" && !Array.isArray(data) && (data as any).error) {
      return { ok: false, kind: "not_found", body: data as Record<string, unknown> }
    }

    // ⚠ The two keys are NORMALIZED TO null when the RPC does not carry them,
    // never defaulted to 0 or to a different metric. An absent field would
    // otherwise vanish from the JSON entirely and the consumer could not tell
    // "not measured" from "measured as zero" — and zero here is a real value
    // (UFC Strike is genuinely 0.0%).
    const enriched: Record<string, unknown> =
      data && typeof data === "object" && !Array.isArray(data)
        ? {
            ...(data as Record<string, unknown>),
            fmv_high_medium_count: (data as any).fmv_high_medium_count ?? null,
            fmv_high_medium_pct: (data as any).fmv_high_medium_pct ?? null,
          }
        : { value: data }

    // ── "Priced from Recent Sales" (known-issues #205, Trevor 2026-10-21) ────
    // The tile used to render fmv_high_medium_pct, the HIGH/MEDIUM confidence
    // share, under a SALES label (Golazos read 0 % beside 84 editions sold this
    // month). It now reads the real share: editions with >= 1 market sale in
    // the last 30 days, from mv_collection_recent_sale_share (hourly). Keyed on
    // the RPC's own normalized slug, so its aliases (`ufc`, `nba`) still land.
    // A failed read OR a row older than RECENT_SALE_MAX_AGE_MS nulls the figure
    // and says why — never a stale or substituted number under this label.
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const share = await readRecentSaleShare(client, String((data as any).slug ?? normalizedSlug), where)
      Object.assign(enriched, share)
    }

    // ── Panini (published 2026-09-25) ──────────────────────────────────────
    // get_collection_stats' generic arm reads SALES and LISTINGS from the Flow
    // feeds (`sales_*`, `cached_listings`), which hold ZERO Panini rows — so it
    // returns volume 0 / no top sales / 0 listings for a market with ~17k live
    // asks. Those zeros are a fact about OUR feeds, not about Panini's market:
    // they are nulled here with `sales_tracked: false`, and the page says "not
    // tracked" instead of "$0" / "No sales in the last 24h". The listing-gated
    // coverage disclosure rides along (lib/panini/coverage.ts).
    //
    // 2026-10-14: the two LIST panels now read Panini's own sources
    // (lib/panini/overview-feeds.ts) — the Sniper tab's hourly deal snapshot and
    // panini_sales' $100+ view — instead of being nulled. Nulling them published
    // "No deals ≥15% off right now" beside a Sniper tab of ~600, and "Sales aren't
    // a tracked feed" over ~588k recorded sales. A failed read nulls the field AND
    // sets its `*_failed` flag, so the panel says "couldn't load", never "none".
    // The 24h KPI fields stay null: Panini sales reach RPC ~2 days after they
    // happen (median, 2026-10-14), so a 24h total would be a fabricated low.
    if (normalizedSlug === "panini_blockchain") {
      const [cov, deals, sales] = await Promise.all([
        readPaniniCoverage(client, where + "/panini_coverage"),
        readPaniniOverviewDeals(client, where + "/panini_overview_deals"),
        readPaniniTopSales(client, where + "/panini_top_sales"),
      ])
      Object.assign(enriched, {
        volume_24h: null,
        volume_7d: null,
        sales_24h: null,
        top_sales: sales.ok ? sales.rows : null,
        top_sales_failed: !sales.ok,
        top_sales_scope: { days: PANINI_TOP_SALES_DAYS, min_usd: PANINI_TOP_SALES_MIN_USD },
        listing_count: null,
        sniper_deals: deals.ok ? deals.rows : null,
        sniper_deals_failed: !deals.ok,
        sales_tracked: true,
        coverage: cov.ok ? cov.coverage : null,
        coverage_failed: !cov.ok,
      })
    }

    return { ok: true, stats: enriched }
  } catch (err) {
    return { ok: false, kind: "unavailable", error: err }
  }
}

/** The MV refreshes hourly (pg_cron :31); three missed refreshes and the figure is withheld. */
export const RECENT_SALE_MAX_AGE_MS = 3 * 60 * 60 * 1000

export interface RecentSaleShare {
  recent_sale_pct: number | null
  recent_sale_count: number | null
  recent_sale_editions: number | null
  recent_sale_as_of: string | null
  /** true when the row could not be read OR is too old to publish. */
  recent_sale_failed: boolean
}

const NO_SHARE = (): RecentSaleShare => ({
  recent_sale_pct: null,
  recent_sale_count: null,
  recent_sale_editions: null,
  recent_sale_as_of: null,
  recent_sale_failed: true,
})

export async function readRecentSaleShare(
  client: SupabaseClient,
  rpcSlug: string,
  where: string,
  now: number = Date.now(),
): Promise<RecentSaleShare> {
  try {
    const { data, error } = await boundedRead(
      (client as any)
        .from("mv_collection_recent_sale_share")
        .select("editions,editions_sold_30d,recent_sale_pct,computed_at")
        .eq("slug", rpcSlug)
        .limit(1),
      where + "/mv_collection_recent_sale_share",
    )
    if (error || !Array.isArray(data) || data.length === 0) return NO_SHARE()
    const row = data[0] as Record<string, unknown>
    const asOf = typeof row.computed_at === "string" ? row.computed_at : null
    const ageMs = asOf ? now - Date.parse(asOf) : NaN
    const pct = row.recent_sale_pct == null ? NaN : Number(row.recent_sale_pct)
    if (!Number.isFinite(ageMs) || ageMs > RECENT_SALE_MAX_AGE_MS || !Number.isFinite(pct)) {
      return { ...NO_SHARE(), recent_sale_as_of: asOf }
    }
    return {
      recent_sale_pct: pct,
      recent_sale_count: row.editions_sold_30d == null ? null : Number(row.editions_sold_30d),
      recent_sale_editions: row.editions == null ? null : Number(row.editions),
      recent_sale_as_of: asOf,
      recent_sale_failed: false,
    }
  } catch {
    return NO_SHARE()
  }
}

/**
 * The page-side entry: takes the URL slug, owns the client. A server PAGE must
 * not touch `supabaseAdmin` itself — two ratchets count pages that do
 * (`server-page-data-access-ratchet`, `insights-server-pages-bound-their-reads`),
 * because a page-level client is a page-level read nobody's coverage sees.
 */
export function readCollectionStatsForPage(collectionUrlSlug: string, where = "overview/page"): Promise<CollectionStatsRead> {
  return readCollectionStats(supabaseAdmin, normalizeStatsSlug(collectionUrlSlug), where)
}
