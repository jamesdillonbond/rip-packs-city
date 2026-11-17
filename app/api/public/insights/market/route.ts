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
//   collection=nba-top-shot|nfl-all-day              default (ABSENT) nba-top-shot; ⛔ any other value is a 400
//                                                    with no rows — never Top Shot's market under another name.
//                                                    NFL All Day (2026-10-28) reads allday_market_index_daily and
//                                                    has UNCOMMON, no FANDOM. Its board is /insights/allday-market.
//   tier=<a tier of that collection>|ALL             single-tier filter
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
import { boardUnavailable } from "@/lib/insights/board-error";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { fetchMarketIndexRows } from "@/lib/insights/market-index-board";
import { isMarketIndexCollection, marketIndexConfig, type MarketIndexCollection } from "@/lib/insights/market-index-collections";

import { boardRowMetaComplete } from "@/lib/insights/board-meta"

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const url = new URL(req.url);
  const sp = url.searchParams;

  const rawCollection = sp.get("collection");
  if (rawCollection != null && !isMarketIndexCollection(rawCollection)) {
    return NextResponse.json({ error: "collection must be nba-top-shot or nfl-all-day" }, { status: 400 });
  }
  const collection: MarketIndexCollection = rawCollection ?? "nba-top-shot";
  const cfg = marketIndexConfig(collection);

  const tier = sp.get("tier")?.toUpperCase() ?? null;
  const days = Math.max(1, Math.min(120, Number(sp.get("days")) || 120));

  if (tier && !cfg.validTiers.includes(tier)) {
    return NextResponse.json(
      { error: `tier must be one of ${cfg.validTiers.join(",")}` },
      { status: 400 }
    );
  }

  // Paged + bounded in lib/insights/market-index-board.ts (shared with both boards' server pages).
  const { rows: data, error } = await fetchMarketIndexRows(supabase, { collection, days, tier, label: "public/insights/market" });
  if (error) {
    return boardUnavailable(error, "insights/market");
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[public/insights/market] collection=${collection} returned=${data?.length ?? 0} tier=${tier ?? "*"} days=${days} elapsedMs=${elapsedMs}`
  );

  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: cfg.view,
      collection,
      // Paged read (fetchAllPaged walks every row), so this really is a total.
      ...boardRowMetaComplete(data?.length ?? 0),
      elapsed_ms: elapsedMs,
      filters: { collection, tier, days },
    },
    rows: data ?? [],
  });

  // 15-minute edge cache — daily-granularity data, see header note.
  res.headers.set("Cache-Control", "public, s-maxage=900, stale-while-revalidate=120");
  return res;
}
