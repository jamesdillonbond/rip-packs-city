// app/api/public/insights/market/route.ts
//
// PUBLIC INSIGHTS — The RPC Index (tier-segmented Top Shot market index).
//
// Read-only JSON endpoint backing the /insights/market page. Lives under
// /api/public/* so the proxy.ts allowlist lets it through with no auth. Reads
// from the public `topshot_market_index_daily` view (shipped 2026-05-31 via
// audit_20260531_topshot_market_index_daily_view) — a tier-segmented daily
// roll-up of real secondary-market sales (price_usd > 0) over the trailing
// 120 days. security_invoker=on, granted to anon.
//
// WHY tier-segmented and NOT a single headline number: commons dominate by
// COUNT (~450 of ~550 daily sales), so the all-market median is sub-$1 and a
// single "Top Shot is worth $X" figure is actively misleading — the same trap
// as quoting a face-value 200x pack EV. The compelling, honest read is a
// per-tier NORMALIZED index (frontend: index = median_px / median_px[base_day]
// * 100, base = each tier's earliest day in range) shown as a multi-line
// trend, plus a daily $-volume bar from the ALL row.
//
// View columns: d (date), tier (ALL | COMMON | FANDOM | RARE | LEGENDARY |
// ULTIMATE | UNKNOWN), sales, volume_usd, median_px, avg_px, max_px.
//
// Query params:
//   tier=COMMON|FANDOM|RARE|LEGENDARY|ULTIMATE|ALL   single-tier filter
//   days=<1..120>                                    trailing window, default 120
//
// Response:
//   {
//     meta: { fetched_at, source, total_rows, filters: {...} },
//     rows: [{ d, tier, sales, volume_usd, median_px, avg_px, max_px }, ...]
//   }
//
// CACHE: 15-minute s-maxage. The view re-aggregates 120d of sales on read;
// the data only moves once a day, so 15m is well inside the freshness window
// and keeps the read cheap under a viral OG-share spike.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

const VALID_TIERS = new Set([
  "ALL",
  "COMMON",
  "FANDOM",
  "RARE",
  "LEGENDARY",
  "ULTIMATE",
  "UNKNOWN",
]);

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const url = new URL(req.url);
  const sp = url.searchParams;

  const tier = sp.get("tier")?.toUpperCase() ?? null;
  const days = Math.max(1, Math.min(120, Number(sp.get("days") ?? "120")));

  if (tier && !VALID_TIERS.has(tier)) {
    return NextResponse.json(
      { error: `tier must be one of ${[...VALID_TIERS].join(",")}` },
      { status: 400 }
    );
  }

  // Trailing-window cutoff (inclusive). The view holds ~120 days, so the
  // default returns everything; a smaller `days` trims it server-side.
  const cutoff = new Date(Date.now() - days * 86_400_000)
    .toISOString()
    .slice(0, 10);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (supabase as any)
    .from("topshot_market_index_daily")
    .select("d, tier, sales, volume_usd, median_px, avg_px, max_px")
    .gte("d", cutoff)
    .order("d", { ascending: true })
    .order("tier", { ascending: true })
    .limit(2000);

  if (tier) q = q.eq("tier", tier);

  const { data, error } = await q;
  if (error) {
    console.error("[public/insights/market]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[public/insights/market] returned=${data?.length ?? 0} tier=${tier ?? "*"} days=${days} elapsedMs=${elapsedMs}`
  );

  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "topshot_market_index_daily",
      total_rows: data?.length ?? 0,
      elapsed_ms: elapsedMs,
      filters: { tier, days },
    },
    rows: data ?? [],
  });

  // 15-minute edge cache — daily-granularity data, see header note.
  res.headers.set("Cache-Control", "public, s-maxage=900, stale-while-revalidate=120");
  return res;
}
