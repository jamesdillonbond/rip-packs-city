// app/api/public/insights/offer-spread/route.ts
//
// PUBLIC INSIGHTS — Top Shot Bid vs Floor (offer/ask spread board).
//
// Read-only JSON endpoint backing the /insights/offer-spread page. Lives under
// /api/public/* so the proxy.ts allowlist lets it through with no auth. Reads
// the public `topshot_offer_ask_spread` view (shipped 2026-06-01 via
// audit_20260601_topshot_offer_ask_spread_view -> _v2_honest_rank ->
// _v3_par_distance). security_invoker=on, anon SELECT-only; backing
// edition_offers hardened (RLS on, anon SELECT-only).
//
// What it surfaces: TS editions that have BOTH a standing offer (bid) and a
// floor ask, ranked by how tightly the two meet. A bid at/above the floor is
// EITHER instant liquidity OR a stale / different-serial cheap listing — we
// show the floor ask next to the bid so the reader can judge. NOT promoted as
// guaranteed arbitrage (per the "rank, not price" lesson).
//
// Query params:
//   tier=COMMON|RARE|LEGENDARY|FANDOM|ULTIMATE   single tier filter
//   min_ask=<number>                              floor on low_ask (default 0;
//                                                 the board view passes 5 to
//                                                 hide penny-floor ratio noise)
//   bid_meets_ask=true                            only rows where bid >= floor
//   set=<text>                                    ilike match on set_name
//   player=<text>                                 ilike match on player_name
//   sort=par|spread|offer|ask|pct                 default par (tightest first)
//   limit=<1..200>                                default 50
//
// CACHE: 5-minute s-maxage. edition_offers refreshes continuously via the
// offers-sweep cron, so 5m is well inside the freshness window and protects
// the DB from a viral OG-share spike.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

const VALID_TIERS = new Set(["COMMON", "RARE", "LEGENDARY", "FANDOM", "ULTIMATE"]);
const VALID_SORTS = new Set(["par", "spread", "offer", "ask", "pct"]);

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const sp = new URL(req.url).searchParams;

  const tier = sp.get("tier")?.toUpperCase() ?? null;
  // min_ask floors out penny-floor ratio artifacts. Default 0 so player/set
  // drill-downs never empty (QA point 6); the page's board view passes 5.
  const minAsk = Number(sp.get("min_ask") ?? "0");
  const bidMeetsAsk = sp.get("bid_meets_ask") === "true";
  const setFilter = sp.get("set")?.trim() ?? null;
  const playerFilter = sp.get("player")?.trim() ?? null;
  const sort = sp.get("sort") ?? "par";
  const limit = Math.max(1, Math.min(200, Number(sp.get("limit") ?? "50")));

  if (tier && !VALID_TIERS.has(tier)) {
    return NextResponse.json({ error: `tier must be one of ${[...VALID_TIERS].join(",")}` }, { status: 400 });
  }
  if (!Number.isFinite(minAsk) || minAsk < 0) {
    return NextResponse.json({ error: "min_ask must be a non-negative number" }, { status: 400 });
  }
  if (!VALID_SORTS.has(sort)) {
    return NextResponse.json({ error: `sort must be one of ${[...VALID_SORTS].join(",")}` }, { status: 400 });
  }

  let q = (supabase as any)
    .from("topshot_offer_ask_spread")
    .select("external_id, name, player_name, set_name, tier, circulation_count, highest_offer, low_ask, offer_pct_of_ask, par_distance, spread_usd, bid_meets_ask, updated_at")
    .gte("low_ask", minAsk);

  if (tier) q = q.eq("tier", tier);
  if (bidMeetsAsk) q = q.eq("bid_meets_ask", true);
  if (setFilter) q = q.ilike("set_name", `%${setFilter}%`);
  if (playerFilter) q = q.ilike("player_name", `%${playerFilter}%`);

  if (sort === "par") q = q.order("par_distance", { ascending: true });
  else if (sort === "spread") q = q.order("spread_usd", { ascending: true });
  else if (sort === "offer") q = q.order("highest_offer", { ascending: false });
  else if (sort === "ask") q = q.order("low_ask", { ascending: false });
  else if (sort === "pct") q = q.order("offer_pct_of_ask", { ascending: false });

  q = q.limit(limit);

  const { data, error } = await q;
  if (error) {
    console.error("[public/insights/offer-spread]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "topshot_offer_ask_spread",
      total_rows: data?.length ?? 0,
      elapsed_ms: Date.now() - startedAt,
      filters: { tier, min_ask: minAsk, bid_meets_ask: bidMeetsAsk, set: setFilter, player: playerFilter, sort, limit },
    },
    rows: data ?? [],
  });
  res.headers.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");
  return res;
}
