// app/api/public/insights/first-mint/route.ts
//
// PUBLIC INSIGHTS — Top Shot First-Mint Trophy Tracker.
//
// Read-only JSON endpoint backing the (planned) /insights/first-mint page.
// Lives under /api/public/* so the proxy.ts allowlist lets it through with
// no auth. Reads from two public views shipped 2026-05-30 via
// audit_20260530_topshot_first_mint_trophy_views_for_surface_d:
//
//   topshot_first_mint_trophy_stats — single-row 90d cohort KPIs
//   topshot_first_mint_trophies     — per-#1-sale row, ranked by multiplier
//
// Thesis: "trophies aren't a vibe, they're math." Headline data
// (2026-05-30):
//   452 #1 sales in last 90d with comparison data
//   Avg multiplier vs avg-other-serial: 15.8×
//   Median: 8.3×, Max: 248.7× (LeBron Top Shot This Playoffs FANDOM #1)
//   295 trophies sold ≥5×, 198 ≥10×, 24 ≥50×, 8 ≥100×
//   Top dollar: Jokić Base Set Common #1 → $9,000 (188× the $47.73 avg)
//
// Query params:
//   limit=<1..200>        default 50, applies only to the trophies list
//   min_multiplier=<n>    optional floor on multiplier (e.g. 10)
//
// CACHE: 5-minute s-maxage.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? "50")));
  const minMult = url.searchParams.get("min_multiplier")
    ? Number(url.searchParams.get("min_multiplier"))
    : null;
  // Optional: "trophy-only" view (max_circulation=100 by convention) keeps
  // the headline-grade scarcity trophies and drops the Common-tier outliers.
  const maxCirculation = url.searchParams.get("max_circulation")
    ? Number(url.searchParams.get("max_circulation"))
    : null;
  const tier = url.searchParams.get("tier")?.toUpperCase() ?? null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (supabase as any)
    .from("topshot_first_mint_trophies")
    .select(
      "edition_id, external_id, player_name, set_name, tier, circulation_count, mint_one_sold_at, mint_one_price_usd, avg_other_serial_price_usd, other_serial_sample_n, multiplier, transaction_hash"
    );
  if (minMult != null && Number.isFinite(minMult)) {
    q = q.gte("multiplier", minMult);
  }
  if (maxCirculation != null && Number.isFinite(maxCirculation)) {
    q = q.lte("circulation_count", maxCirculation);
  }
  if (tier) {
    q = q.eq("tier", tier);
  }
  q = q.order("multiplier", { ascending: false, nullsFirst: false }).limit(limit);

  const [statsRes, trophiesRes] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).from("topshot_first_mint_trophy_stats").select("*").limit(1),
    q,
  ]);

  if (statsRes.error) {
    console.error("[public/insights/first-mint] stats", statsRes.error);
    return NextResponse.json({ error: statsRes.error.message }, { status: 500 });
  }
  if (trophiesRes.error) {
    console.error("[public/insights/first-mint] trophies", trophiesRes.error);
    return NextResponse.json({ error: trophiesRes.error.message }, { status: 500 });
  }

  const elapsedMs = Date.now() - startedAt;
  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      sources: ["topshot_first_mint_trophy_stats", "topshot_first_mint_trophies"],
      elapsed_ms: elapsedMs,
      filters: { limit, min_multiplier: minMult, max_circulation: maxCirculation, tier },
    },
    stats: statsRes.data?.[0] ?? null,
    trophies: trophiesRes.data ?? [],
  });

  res.headers.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");
  return res;
}
