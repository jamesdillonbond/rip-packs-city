// app/api/public/insights/deals/route.ts
//
// PUBLIC INSIGHTS — Below FMV (cross-collection deals vs fair value board).
//
// Read-only JSON endpoint backing the /insights/deals page. Lives under
// /api/public/* so the proxy.ts allowlist lets it through with no auth. Reads
// the public `cross_collection_deals_board` view (shipped 2026-06-07 via
// audit_20260607_cross_collection_deals_board_view). security_invoker=on, anon
// SELECT-only. The view UNIONs THREE legs (verified against pg_get_viewdef
// 2026-07-28 — the "two legs" this comment used to claim was stale):
//   - Top Shot: editions whose floor ask (edition_offers.low_ask) is below a
//     HIGH/MEDIUM-confidence latest FMV (the original topshot_deals_vs_fmv
//     logic, composed unchanged). Gates low_ask>=5.
//   - NFL All Day: allday_edition_floor_ask joined to the latest fmv_snapshots
//     row per edition. Gates low_ask>=1. This is the LARGEST leg of the board
//     (47% of rows at the default >=10% gap).
//   - Disney Pinnacle: render-spine rows (pinnacle_catalog floor_ask vs
//     per-render FMV), gated fmv_sales_count_30d>=8 + floor freshness<=3d.
//     Gates low_ask>=1.
//
// All three gate confidence IN (HIGH,MEDIUM) + low_ask<fmv so it's REAL
// discounts, not stale-FMV artifacts. The minimum ask is NOT uniform — only
// Top Shot gates at $5; the other two gate at $1, so ~40% of board rows sit
// under $5 (do not re-assert a blanket "$5+ floor" in copy). This is the
// public, honest, top-of-funnel counterpart to the auth-gated sniper. NOT
// promoted as guaranteed arbitrage (a big gap can be a low-serial / stale
// listing).
//
// low_confidence_fmv (TS leg): flags the ~2% thin-data residual where WAP/mean FMV
// overshoots the 90d median on <15 sales/90d, so a near-median ask reads as a big
// fake "discount" (precomputed in topshot_thin_fmv_editions; see
// audit_20260621_topshot_thin_fmv_deal_flag). The board still SHOWS these — the UI
// renders a "thin data" caveat instead of a confident discount. Alerts suppress them.
//
// tier and confidence are TEXT here (Pinnacle tiers are variant names like
// "Standard" / "Digital Display", not the TS enum), plus the view carries
// collection_slug, collection_name, render_id, detail_url (internal drill-down:
// TS edition page / Pinnacle pin page), and thumbnail_url (Pinnacle proxy
// image; NULL for TS).
//
// Query params:
//   collection=nba_top_shot|nfl_all_day|disney_pinnacle|candy_mlb|panini_blockchain
//                                                 single collection filter
//   tier=<text>                                   single tier filter (free-text;
//                                                 TS enum values or Pinnacle
//                                                 variant names)
//   min_discount=<number>                         floor on discount_pct
//                                                 (default 0; the board view
//                                                 passes 10)
//   confidence=HIGH|MEDIUM                         single confidence filter
//   set=<text>                                    ilike match on set_name
//   property=<slug>                               league / brand (2026-11-26); needs collection=panini_blockchain|candy_mlb
//   player=<text>                                 ilike match on player_name
//   sort=discount|fmv|ask|circulation             default discount (biggest %)
//   limit=<1..200>                                default 50
//
// CACHE: 5-minute s-maxage; fmv-recalc runs daily, so 5m is well inside that.
// ⚠ THIS USED TO ADD "asks/floors refresh continuously" as the other half of the
// justification. The cache window is still right; that half was a dependency stated
// with no expiry — `offers-sweep` is the ask side's ONLY writer, and when its upstream
// died the column froze for 30 h at a median age of 30.0 h. `ask_updated_at` ships in
// every row so the reader can tell the cache age from the data age; see
// lib/market/ask-freshness.ts.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { readDealsAsOf } from "@/lib/insights/mv-freshness";
import { boardUnavailable } from "@/lib/insights/board-error";
import { boundedRead } from "@/lib/api/bounded-read";
import { retryEmptyPlayerSearch } from "@/lib/search/player-search-retry";
import { fromDbSlug, getCollectionUuid } from "@/lib/collections";

import { boardRowMeta } from "@/lib/insights/board-meta"
import { cleanScopeSlug, paniniSetIdOf } from "@/lib/panini/scope"
// Keep in sync with COLLECTIONS in app/insights/deals/DealsBoardClient.tsx.
// nfl_all_day was missing until 2026-07-28 even though the view has always
// served it — and it is the board's LARGEST leg (47% of rows at the default
// >=10% gap), so this allowlist was 400-ing the single biggest slice of its own
// payload and telling the caller that collection was not valid.
// ⚠ FOUR LEGS since 2026-09-19. This allowlist is a 400-gate, so a leg missing
// here is a slice of the payload a consumer is told does not exist — the exact
// defect filed for NFL All Day on 2026-07-28, when the biggest leg of the board
// returned HTTP 400. `__tests__/insights-deals-surface-contract.test.ts` pins
// every surface that has to name a leg; add to it, never weaken it.
const VALID_COLLECTIONS = new Set(["nba_top_shot", "nfl_all_day", "disney_pinnacle", "candy_mlb", "panini_blockchain"]);
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
  const limit = Math.max(1, Math.min(200, Number(sp.get("limit")) || 50));

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

  // ── League / brand scope (2026-11-26): ?property=<slug>, for Panini or Candy only ─────────────────────
  // Resolved BEFORE the board read: an unknown slug (or one on a collection with no leagues) is a 400, a
  // failed lookup the board's own unavailable response — never the whole collection under a league's name.
  //   Panini → the league's product ids; rows narrowed at the source by key prefix and re-checked exactly
  //            (LIKE's `_` is a wildcard, so a longer id sharing the prefix can come back).
  //   Candy  → the brand's collection names; Candy's leg is small, so it is read whole (clamp-checked) and
  //            narrowed here, keeping the board's sort. A clamped read is refused, not served short.
  const propertyRaw = sp.get("property")?.trim() ?? "";
  let paniniIds: Set<number> | null = null;
  let candySets: Set<string> | null = null;
  type ScopeChain = { select: (c: string) => ScopeChain; eq: (c: string, v: string) => ScopeChain; neq: (c: string, v: string) => ScopeChain; order: (c: string, o: { ascending: boolean }) => ScopeChain; limit: (n: number) => PromiseLike<unknown> };
  const scopeDb = supabase as unknown as { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<unknown>; from: (t: string) => ScopeChain };
  if (propertyRaw) {
    const slug = cleanScopeSlug(propertyRaw);
    const unknownLeague = () => NextResponse.json({ error: "unknown league or brand for this collection" }, { status: 400 });
    if (!slug || (collection !== "panini_blockchain" && collection !== "candy_mlb")) return unknownLeague();
    if (collection === "panini_blockchain") {
      const ids = await boundedRead(scopeDb.rpc("panini_property_set_ids", { p_slug: slug }), "api/public/insights/deals/panini_property_set_ids");
      if (ids.error) return boardUnavailable(ids.error, "insights/deals");
      const list = (Array.isArray(ids.data) ? ids.data : []).map(Number).filter((n: number) => Number.isSafeInteger(n));
      if (list.length === 0) return unknownLeague();
      paniniIds = new Set(list);
    } else {
      const names = await boundedRead(
        scopeDb.from("candy_collections").select("name").eq("property_slug", slug).neq("kind", "test").order("address", { ascending: true }).limit(1000),
        "api/public/insights/deals/candy_property_names",
      );
      if (names.error) return boardUnavailable(names.error, "insights/deals");
      if (!Array.isArray(names.data) || names.data.length >= 1000) return boardUnavailable(new Error("candy property names: a non-list or clamped read"), "insights/deals");
      if (names.data.length === 0) return unknownLeague();
      candySets = new Set((names.data as Array<{ name?: unknown }>).map((r) => r.name).filter((n): n is string => typeof n === "string"));
    }
  }
  const CANDY_WINDOW = 1000;

  const build = (player: string | null) => {
    let q = (supabase as any)
      .from("cross_collection_deals_board")
      .select("external_id, name, player_name, set_name, tier, circulation_count, fmv_usd, confidence, low_ask, discount_pct, discount_usd, ask_updated_at, collection_slug, collection_name, render_id, detail_url, thumbnail_url, low_confidence_fmv")
      .gte("discount_pct", minDiscount);

    if (collection) q = q.eq("collection_slug", collection);
    if (tier) q = q.eq("tier", tier);
    if (confidence) q = q.eq("confidence", confidence);
    if (setFilter) q = q.ilike("set_name", `%${setFilter}%`);
    if (player) q = q.ilike("player_name", `%${player}%`);
    if (paniniIds) q = q.or([...paniniIds].map((id) => `external_id.like.packcard-${id}_*`).join(","));

    if (sort === "discount") q = q.order("discount_pct", { ascending: false });
    else if (sort === "fmv") q = q.order("fmv_usd", { ascending: false, nullsFirst: false });
    else if (sort === "ask") q = q.order("low_ask", { ascending: true });
    else if (sort === "circulation") q = q.order("circulation_count", { ascending: true, nullsFirst: false });

    return boundedRead(q.limit(candySets ? CANDY_WINDOW : limit), "api/public/insights/deals/cross_collection_deals_board");
  };

  // #207: an accent-only miss ("doncic") is retried with the resolver's single
  // spelling and reported in meta.player_resolved (lib/search/player-search-retry).
  const { data, error, playerResolved } = await retryEmptyPlayerSearch({
    supabase,
    collectionUuid: (collection ? [collection] : [...VALID_COLLECTIONS]).map((c) => getCollectionUuid(fromDbSlug(c) ?? "")).filter((u): u is string => !!u),
    typed: playerFilter,
    first: await build(playerFilter),
    run: (label) => build(label),
  });
  if (error) {
    return boardUnavailable(error, "insights/deals");
  }
  let scoped = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>;
  if (paniniIds) {
    const ids = paniniIds;
    scoped = scoped.filter((r) => { const id = paniniSetIdOf(typeof r?.external_id === "string" ? r.external_id : null); return id != null && ids.has(id); });
  } else if (candySets) {
    // A window that filled cannot be told from a longer board — refuse rather than serve a brand short.
    if (scoped.length >= CANDY_WINDOW) return boardUnavailable(new Error("candy deals window clamped under a brand scope"), "insights/deals");
    const sets = candySets;
    scoped = scoped.filter((r) => typeof r?.set_name === "string" && sets.has(r.set_name as string)).slice(0, limit);
  }

  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      // ⚠ How old the ROWS are (this board reads a materialized view since 2026-08-22).
      // `fetched_at` is only when we answered. null = cannot tell, never now().
      // Two MVs feed this board (2026-10-27): the stamp is the leg(s) actually shown, older first.
      data_as_of: await readDealsAsOf(collection),
      source: "cross_collection_deals_board",
      ...boardRowMeta(scoped.length, limit),
      elapsed_ms: Date.now() - startedAt,
      filters: { collection, tier, min_discount: minDiscount, confidence, set: setFilter, player: playerFilter, sort, limit, property: propertyRaw || null },
      ...(playerResolved ? { player_resolved: playerResolved } : {}),
    },
    rows: scoped,
  });
  res.headers.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");
  return res;
}
