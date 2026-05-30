// app/api/public/insights/cross-collection/route.ts
//
// PUBLIC INSIGHTS — Cross-Collection Whale Map.
//
// Read-only JSON endpoint backing /insights/cross-collection. Reads from
// the three materialized cohort surfaces shipped 2026-05-30:
//   cross_collection_cohort_mat       — per-wallet rollup
//   cross_collection_cohort_stats     — single-row KPIs
//   cross_collection_ts_set_overlap_mat — what TS sets the cohort collects
//
// Why this exists: per the 2026-05-29 research integration finding, 143
// wallets hold 3+ Flow collections — "RPC's natural intelligence-product
// audience." Top Shot's site has no way to surface a cohort that
// crosses collection boundaries. We do.
//
// Query params:
//   sort=moments|fmv|n_coll|ts|allday|golazos|pinnacle|ufc  default moments
//   limit=<1..200>                                          default 100
//
// CACHE: 30-minute s-maxage. The cohort tables are refreshed via the
// refresh_cross_collection_cohort_step1/step2 RPCs (manual or chained
// from a future cron). Underlying wmc state changes slowly (wallet
// scans are 6h+), so 30min is plenty.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

const VALID_SORTS = new Set([
  "moments",
  "fmv",
  "n_coll",
  "ts",
  "allday",
  "golazos",
  "pinnacle",
  "ufc",
]);

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const url = new URL(req.url);
  const sort = url.searchParams.get("sort") ?? "moments";
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? "100")));

  if (!VALID_SORTS.has(sort)) {
    return NextResponse.json(
      { error: `sort must be one of ${[...VALID_SORTS].join(",")}` },
      { status: 400 }
    );
  }

  const orderCol =
    sort === "moments"
      ? "total_moments"
      : sort === "fmv"
        ? "approx_fmv_usd"
        : sort === "n_coll"
          ? "n_collections"
          : sort === "ts"
            ? "ts_moments"
            : sort === "allday"
              ? "allday_moments"
              : sort === "golazos"
                ? "golazos_moments"
                : sort === "pinnacle"
                  ? "pinnacle_moments"
                  : "ufc_moments";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cohortQ = (supabase as any)
    .from("cross_collection_cohort_mat")
    .select(
      "wallet_address, n_collections, total_moments, ts_moments, allday_moments, golazos_moments, pinnacle_moments, ufc_moments, approx_fmv_usd"
    )
    .order(orderCol, { ascending: false, nullsFirst: false })
    .limit(limit);

  const [statsRes, cohortRes, setOverlapRes] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).from("cross_collection_cohort_stats").select("*").limit(1),
    cohortQ,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("cross_collection_ts_set_overlap_mat")
      .select("set_id, set_name, cohort_holders, moments_in_cohort")
      .order("cohort_holders", { ascending: false })
      .limit(30),
  ]);

  if (statsRes.error) {
    console.error("[public/insights/cross-collection] stats", statsRes.error);
    return NextResponse.json({ error: statsRes.error.message }, { status: 500 });
  }
  if (cohortRes.error) {
    console.error("[public/insights/cross-collection] cohort", cohortRes.error);
    return NextResponse.json({ error: cohortRes.error.message }, { status: 500 });
  }
  if (setOverlapRes.error) {
    console.error("[public/insights/cross-collection] set-overlap", setOverlapRes.error);
    return NextResponse.json({ error: setOverlapRes.error.message }, { status: 500 });
  }

  const elapsedMs = Date.now() - startedAt;
  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      sources: [
        "cross_collection_cohort_stats",
        "cross_collection_cohort_mat",
        "cross_collection_ts_set_overlap_mat",
      ],
      elapsed_ms: elapsedMs,
      filters: { sort, limit },
    },
    stats: statsRes.data?.[0] ?? null,
    wallets: cohortRes.data ?? [],
    ts_set_overlap: setOverlapRes.data ?? [],
  });

  res.headers.set("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=300");
  return res;
}
