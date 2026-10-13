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
import { boundedRead } from "@/lib/api/bounded-read"
import { readPaniniCoverage } from "@/lib/panini/coverage"

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

    // ── Panini (published 2026-09-25) ──────────────────────────────────────
    // get_collection_stats' generic arm reads SALES and LISTINGS from the Flow
    // feeds (`sales_*`, `cached_listings`), which hold ZERO Panini rows — so it
    // returns volume 0 / no top sales / 0 listings for a market with ~17k live
    // asks. Those zeros are a fact about OUR feeds, not about Panini's market:
    // they are nulled here with `sales_tracked: false`, and the page says "not
    // tracked" instead of "$0" / "No sales in the last 24h". The listing-gated
    // coverage disclosure rides along (lib/panini/coverage.ts).
    if (normalizedSlug === "panini_blockchain") {
      const cov = await readPaniniCoverage(client, where + "/panini_coverage")
      Object.assign(enriched, {
        volume_24h: null,
        volume_7d: null,
        sales_24h: null,
        top_sales: null,
        listing_count: null,
        sniper_deals: null,
        sales_tracked: false,
        coverage: cov.ok ? cov.coverage : null,
        coverage_failed: !cov.ok,
      })
    }

    return { ok: true, stats: enriched }
  } catch (err) {
    return { ok: false, kind: "unavailable", error: err }
  }
}
