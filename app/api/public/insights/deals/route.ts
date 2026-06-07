// app/api/public/insights/deals/route.ts
//
// PUBLIC INSIGHTS — Below FMV (cross-collection deals vs fair value board).
//
// Read-only JSON endpoint backing the /insights/deals page. Lives under
// /api/public/* so the proxy.ts allowlist lets it through with no auth. Reads
// the public `cross_collection_deals_board` view (shipped 2026-06-07 via
// audit_20260607_cross_collection_deals_board_view). security_invoker=on, anon
// SELECT-only. The view UNIONs two legs:
//   - Top Shot: editions whose floor ask (edition_offers.low_ask) is below a
//     HIGH/MEDIUM-confidence latest FMV (the original topshot_deals_vs_fmv
//     logic, composed unchanged).
//   - Disney Pinnacle: render-spine rows (pinnacle_catalog floor_ask vs
//     per-render FMV), gated HIGH/MEDIUM + fmv_sales_count_30d>=8 + floor
//     freshness<=3d.
//
// Both legs gate low_ask>=5 + confidence IN (HIGH,MEDIUM) + low_ask<fmv so it's
// REAL discounts, not stale-FMV / penny-floor artifacts. This is the public,
// honest, top-of-funnel counterpart to the auth-gated sniper. NOT promoted as
// guaranteed arbitrage (a big gap can be a low-serial / stale listing).
//
// tier and confidence are TEXT here (Pinnacle tiers are variant names like
// "Standard" / "Digital Display", not the TS enum), plus the view carries
// collection_slug, collection_name, render_id, detail_url (internal drill-down:
// TS edition page / Pinnacle pin page), and thumbnail_url (Pinnacle proxy
// image; NULL for TS).
//
// Query params:
//   collection=nba_top_shot|disney_pinnacle       single collection filter
//   tier=<text>                                   single tier filter (free-text;
//                                                 TS enum values or Pinnacle
//                                                 variant names)
//   min_discount=<number>                         floor on discount_pct
//                                                 (default 0; the board view
//                                                 passes 10)
//   confidence=HIGH|MEDIUM                         single confidence filter
//   set=<text>                                    ilike match on set_name
//   player=<text>                                 ilike match on player_name
//   sort=discount|fmv|ask|circulation             default discount (biggest %)
//   limit=<1..200>                                default 50
//
// CACHE: 5-minute s-maxage. asks/floors refresh continuously; fmv-recalc runs
// daily — both well inside a 5m window.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

const VALID_COLLECTIONS = new Set(["nba_top_shot", "disney_pinnacle"]);
const VALID_CONF = new Set(["HIGH", "MEDIUM"]);
const VALID_SORTS = new Set(["discount", "fmv", "ask", "circulation"]);

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const sp = new URL(req.url).searchParams;

  const collection = sp.get("collection")?.trim() ?? null;
  // tier is free-text in the cross-collection view (Pinnacle variants aren't
  // the TS enum), so no allowlist — just an exact match on any non-empty value.
  const tier = sp.get("tier")?.trim() || null;
  // min_discount floors the board to meaningful gaps. Default 0 so player/set
  // drill-downs never empty (QA point 6); the page's board view passes 10.
  const minDiscount = Number(sp.get("min_discount") ?? "0");
  const confidence = sp.get("confidence")?.toUpperCase() ?? null;
  const setFilter = sp.get("set")?.trim() ?? null;
  const playerFilter = sp.get("player")?.trim() ?? null;
  const sort = sp.get("sort") ?? "discount";
  const limit = Math.max(1, Math.min(200, Number(sp.get("limit") ?? "50")));

  if (collection && !VALID_COLLECTIONS.has(collection)) {
    return NextResponse.json({ error: `collection must be one of ${[...VALID_COLLECTIONS].join(",")}` }, { status: 400 });
  }
  if (confidence && !VALID_CONF.has(confidence)) {
    return NextResponse.json({ error: `confidence must be one of ${[...VALID_CONF].join(",")}` }, { status: 400 });
  }
  if (!Number.isFinite(minDiscount) || minDiscount < 0) {
    return NextResponse.json({ error: "min_discount must be a non-negative number" }, { status: 400 });
  }
  if (!VALID_SORTS.has(sort)) {
    return NextResponse.json({ error: `sort must be one of ${[...VALID_SORTS].join(",")}` }, { status: 400 });
  }

  let q = (supabase as any)
    .from("cross_collection_deals_board")
    .select("external_id, name, player_name, set_name, tier, circulation_count, fmv_usd, confidence, low_ask, discount_pct, discount_usd, ask_updated_at, collection_slug, collection_name, render_id, detail_url, thumbnail_url")
    .gte("discount_pct", minDiscount);

  if (collection) q = q.eq("collection_slug", collection);
  if (tier) q = q.eq("tier", tier);
  if (confidence) q = q.eq("confidence", confidence);
  if (setFilter) q = q.ilike("set_name", `%${setFilter}%`);
  if (playerFilter) q = q.ilike("player_name", `%${playerFilter}%`);

  if (sort === "discount") q = q.order("discount_pct", { ascending: false });
  else if (sort === "fmv") q = q.order("fmv_usd", { ascending: false, nullsFirst: false });
  else if (sort === "ask") q = q.order("low_ask", { ascending: true });
  else if (sort === "circulation") q = q.order("circulation_count", { ascending: true, nullsFirst: false });

  q = q.limit(limit);

  const { data, error } = await q;
  if (error) {
    console.error("[public/insights/deals]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "cross_collection_deals_board",
      total_rows: data?.length ?? 0,
      elapsed_ms: Date.now() - startedAt,
      filters: { collection, tier, min_discount: minDiscount, confidence, set: setFilter, player: playerFilter, sort, limit },
    },
    rows: data ?? [],
  });
  res.headers.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");
  return res;
}
