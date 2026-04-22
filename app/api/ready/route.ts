// app/api/ready/route.ts
//
// Readiness signal — runs the heavy health_check RPC against Supabase and
// folds fmv/sales/listings per-collection telemetry into one response.
// Kept separate from /api/health (liveness) so a slow or timing-out
// Supabase doesn't cascade into "the app is down" on monitoring tools.
//
// Consumers:
//   - /[collection]/market  → thin-volume notice (sales_24h < 10)
//   - /[collection]/analytics → same
//   - Dashboards / readiness probes
//
// Response shape is the same as the pre-split /api/health:
// {
//   status: "ok" | "degraded" | "error",
//   fmv_pipeline, data_integrity, ... (whatever health_check returns)
//   per_collection: [
//     {
//       slug, db_slug, name,
//       fmv_coverage_pct, fmv_last_computed, fmv_staleness_minutes,
//       editions,
//       sales_24h, last_sale_at, total_sales,
//       listing_count, listings_last_cached_at, listings_staleness_minutes
//     }
//   ],
//   overall_staleness_minutes: number | null
// }

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
) as any;

export const dynamic = "force-dynamic";
export const maxDuration = 10;

// DB slug -> frontend slug used everywhere else in the app.
const DB_TO_FRONTEND: Record<string, string> = {
  "nba_top_shot": "nba-top-shot",
  "nfl_all_day": "nfl-all-day",
  "laliga_golazos": "laliga-golazos",
  "disney_pinnacle": "disney-pinnacle",
  "ufc_strike": "ufc",
  "ufc": "ufc",
};

function minutesSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

export async function GET() {
  try {
    const { data, error } = await supabase.rpc("health_check");

    if (error) {
      return NextResponse.json(
        { status: "error", error: error.message },
        { status: 500 }
      );
    }

    const fmvByName: Record<string, any> = {};
    for (const row of data?.fmv_pipeline?.per_collection ?? []) {
      if (row?.name) fmvByName[row.name] = row;
    }
    const salesByName: Record<string, any> = {};
    for (const row of data?.sales_pipeline?.per_collection ?? []) {
      if (row?.name) salesByName[row.name] = row;
    }
    const listingsByName: Record<string, any> = {};
    for (const row of data?.listing_cache?.per_collection ?? []) {
      if (row?.name) listingsByName[row.name] = row;
    }

    const perCollection = (data?.collections ?? []).map((c: any) => {
      const fmv = fmvByName[c.name] ?? {};
      const sales = salesByName[c.name] ?? {};
      const listings = listingsByName[c.name] ?? {};
      const frontendSlug = DB_TO_FRONTEND[c.slug] ?? c.slug;
      return {
        slug: frontendSlug,
        db_slug: c.slug,
        name: c.name,
        fmv_coverage_pct: fmv.coverage_pct ?? null,
        fmv_last_computed: fmv.last_computed ?? null,
        fmv_staleness_minutes: minutesSince(fmv.last_computed),
        editions: c.editions ?? 0,
        sales_24h: sales.sales_24h ?? c.sales_24h ?? 0,
        last_sale_at: sales.last_sale ?? null,
        total_sales: sales.total_sales ?? 0,
        listing_count: listings.count ?? c.cached_listings ?? 0,
        listings_last_cached_at: listings.last_cached ?? null,
        listings_staleness_minutes: minutesSince(listings.last_cached),
      };
    });

    const isHealthy =
      !data?.fmv_pipeline?.is_stale && data?.data_integrity?.orphaned_editions_ok !== false;

    const body = {
      ...data,
      per_collection: perCollection,
      overall_staleness_minutes: Math.round(Number(data?.fmv_pipeline?.staleness_minutes ?? 0)),
      status: isHealthy ? "ok" : "degraded",
    };

    return NextResponse.json(body, {
      status: isHealthy ? 200 : 503,
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (err: any) {
    return NextResponse.json(
      { status: "error", error: err?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
