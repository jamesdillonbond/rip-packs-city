// app/api/public/insights/pack-reality/route.ts
//
// PUBLIC INSIGHTS — Top Shot Pack Reality.
//
// Read-only JSON endpoint backing the (planned) /insights/pack-reality page.
// Lives under /api/public/* so the proxy.ts allowlist lets it through with
// no auth. Reads from three public views shipped 2026-05-30 via
// audit_20260530_topshot_pack_reality_views_for_surface_b:
//
//   topshot_pack_reality_stats   — single-row 60d KPIs
//   topshot_pack_reality_dist    — pull-value histogram (6 buckets)
//   topshot_pack_reality_top_ev  — top +EV TS packs with a high-variance flag
//
// Why this exists: per the 2026-05-29 launch plan, "51% of TS pack rips
// deliver $0" is the headline counter-narrative to TS marketplace
// optimism. The dist view answers "how often do you actually pull
// something" and the top_ev view layers a high-variance flag so the
// "+EV" packs are presented with the right confidence caveats
// (fmv_coverage_pct < 80 → "EV is dragged by stale-priced moments").
//
// Query params:
//   limit=<1..100>          default 10, applies only to the top_ev list
//
// Response: { meta, stats, distribution, top_ev }
//
// CACHE: 5-minute s-maxage (pack_rips refreshes hourly; pack_ev_latest
// hourly via the pack-ev refresh cron — 5m well inside both windows).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? "10")));

  const [statsRes, distRes, topEvRes] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).from("topshot_pack_reality_stats").select("*").limit(1),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).from("topshot_pack_reality_dist").select("*"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("topshot_pack_reality_top_ev")
      .select(
        "pack_listing_id, dist_id, pack_name, pack_price, gross_ev, pack_ev, value_ratio, fmv_coverage_pct, edition_count, total_unopened, depletion_pct, snapshotted_at, price_source, high_variance, is_reward_pack, retail_price_usd_normalized, secondary_ask, secondary_available"
      )
      .limit(limit),
  ]);

  if (statsRes.error) {
    console.error("[public/insights/pack-reality] stats", statsRes.error);
    return NextResponse.json({ error: statsRes.error.message }, { status: 500 });
  }
  if (distRes.error) {
    console.error("[public/insights/pack-reality] dist", distRes.error);
    return NextResponse.json({ error: distRes.error.message }, { status: 500 });
  }
  if (topEvRes.error) {
    console.error("[public/insights/pack-reality] top_ev", topEvRes.error);
    return NextResponse.json({ error: topEvRes.error.message }, { status: 500 });
  }

  const elapsedMs = Date.now() - startedAt;
  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      sources: [
        "topshot_pack_reality_stats",
        "topshot_pack_reality_dist",
        "topshot_pack_reality_top_ev",
      ],
      elapsed_ms: elapsedMs,
      filters: { limit },
    },
    stats: statsRes.data?.[0] ?? null,
    distribution: distRes.data ?? [],
    top_ev: topEvRes.data ?? [],
  });

  res.headers.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");
  return res;
}
