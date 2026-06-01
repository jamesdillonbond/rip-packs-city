# Handoff — new public surface /insights/offer-spread (Bid vs Floor)

Plain-text, iPhone-pasteable. No code fences. Turns the live topshot_offer_ask_spread view into a public /insights surface. Follows the rpc-insights-qa checklist; mirrors the proven /insights/squeeze pattern (route + page + layout + OG + sitemap + index card).

CONTEXT — backing data already shipped live by Cowork (QA points 1 + 2 DONE):
- View public.topshot_offer_ask_spread (migs audit_20260601_topshot_offer_ask_spread_view -> _v2_honest_rank -> _v3_par_distance). security_invoker=on, anon SELECT-only. Backing edition_offers hardened (RLS on, anon SELECT-only, anon writes revoked). check_public_security_invariants() = 0.
- Columns: external_id, name, player_name, set_name, tier, circulation_count, highest_offer, low_ask, offer_pct_of_ask, par_distance (= abs(offer_pct_of_ask-100), the tight-spread sort key), spread_usd (low_ask-highest_offer), bid_meets_ask (bool), updated_at.
- Live shape: 5,561 rows (TS editions with BOTH a standing offer and a floor ask), 1,218 with bid_meets_ask=true. Source = edition_offers (offers-sweep cron, refreshes continuously, all rows < ~7h old). This is the marketplace-gated set (8,860 TS editions have any offer; 5,561 have both sides) — NOT all 16K; that's expected (only editions with marketplace presence have an offer+ask).
- THE FRAMING (honest, per the "rank not price" lesson): a bid at/above the floor ask is EITHER instant liquidity OR a stale/serial-mismatched cheap listing. Lead with tightest spreads (par_distance asc); show the floor ask alongside; gate the board to low_ask >= 5 by default so penny-floor ratio artifacts ($1 ask + $400 offer = 40000%) don't headline. Do NOT promote it as guaranteed arbitrage.

Prod: deploy READY past e246f22. No docs/FREEZE.md. Claude Code's direct file read wins over this doc. GUARDRAILS: direct to main, no PRs; commit via PowerShell git; full-file writes; tsc --noEmit clean; deploy READY; smoke after.

================================================================
FILE 1 (NEW) — app/api/public/insights/offer-spread/route.ts
================================================================
Full file (mirrors app/api/public/insights/squeeze/route.ts):

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

================================================================
FILE 2 (NEW) — app/insights/offer-spread/page.tsx
================================================================
Clone app/insights/squeeze/page.tsx and swap the data binding. KEY DIFFERENCES (do these exactly):
- Fetch /api/public/insights/offer-spread. Board (default, no filter) view: min_ask=5 (hide penny floors), sort=par, limit=50. A "Bid >= floor only" toggle adds bid_meets_ask=true. A tier dropdown (TS tiers). Player/set drill-downs (from ?player=/?set= query params, like squeeze) MUST send min_ask=0 so partial matches render (QA point 6).
- Header copy (honest): h1 "Bid vs Floor", sub "Top Shot editions where the highest standing offer meets or approaches the lowest ask. A bid at or above the floor can mean instant liquidity — or a stale / different-serial listing. We show the floor ask next to the bid so you can judge."
- KPI cards: (1) "Bid >= floor" = count where bid_meets_ask (on the >=$5 board); (2) "Within 10% of floor" = count where par_distance <= 10; (3) median spread_usd; (4) rows shown.
- Table columns: Player / Edition (link to /nba-top-shot/edition/<encodeURIComponent(external_id)>), Tier chip, Top bid (highest_offer), Floor ask (low_ask), Bid % of floor (offer_pct_of_ask, with a chip when bid_meets_ask), Spread (spread_usd), Mint (circulation_count). MUST wrap the <table> in <div style={{overflowX:"auto"}}> (the .rpc-scroll-x pattern) — the insights TOOL tables overflow on mobile (the A4 finding), so do it right here from the start.
- Honest empty state when rows=[] (e.g. a drill-down with no spread data): "No editions with both a live bid and a floor ask match." Not a blank.
- Brand: var(--rpc-red) / var(--font-display) / var(--font-mono) only. SVG fill/stroke hexes are the one allowed literal exception (same as the other insights pages).
- "use client" for the interactive board; the page is anon-public (proxy already allows /insights/*).

================================================================
FILE 3 (NEW) — app/insights/offer-spread/layout.tsx
================================================================
Clone app/insights/squeeze/layout.tsx. Set: title "Bid vs Floor — Top Shot Offer/Ask Spread | Rip Packs City"; description "Top Shot editions where the top standing offer meets or approaches the floor ask — liquidity and bid-vs-floor intelligence."; alternates.canonical = `${SITE}/insights/offer-spread` (PARAM-STRIPPED self-canonical so ?player=/?set=/?tier= don't index as dupes — QA point 5); WebApplication (or Dataset) JSON-LD; openGraph.images -> the OG route below.

================================================================
FILE 4 (NEW) — app/api/og/insights/offer-spread/route.tsx
================================================================
Clone app/api/og/insights/market/route.tsx (the most recent insights OG). 1200x630 branded card. Live headline pulled from the route or view, e.g. "<N> editions where the top bid meets the floor" + "Top Shot · Bid vs Floor" + RPC logo/red. Satori can't read CSS vars, so hardcoded hex in the OG is the allowed exception.

================================================================
FILE 5 (EDIT) — app/sitemap.ts
================================================================
Add 'offer-spread' to the INSIGHT_ROUTES array (currently lists squeeze, pack-reality, rookies, first-mint, cross-collection, set-squeeze, pinnacle-scarcity, market, squeeze-check, tc-report). QA point 4 — crawlers must be told.

================================================================
FILE 6 (EDIT) — app/insights/page.tsx (the /insights index)
================================================================
Add a card linking to /insights/offer-spread, matching the existing surface cards (title "Bid vs Floor", one-line desc, the same card component/grid). So the new surface is discoverable from the hub.

================================================================
QA CHECKLIST (rpc-insights-qa) — status
================================================================
1. Backing data: DONE — view returns 5,561 rows.
2. Security: DONE — view security_invoker=on; edition_offers RLS on + anon SELECT-only; check_public_security_invariants()=0.
3. Route + page + OG: build all three (Files 1-4); after deploy smoke /api/public/insights/offer-spread (200 JSON), /insights/offer-spread (anon 200), /api/og/insights/offer-spread (200 image).
4. Sitemap: File 5.
5. Canonical: File 3 param-stripped self-canonical.
6. Drill-downs: route default min_ask=0 so ?player=/?set= never empty; board view sends min_ask=5.
7. Freshness + honesty: edition_offers refreshes continuously (offers-sweep cron); honest empty state in the page; honest "bid>=floor can be stale" framing.
8. Brand: tokens only (SVG/OG hex exceptions noted).

POST-SHIP: smoke all insights surfaces in one pass; add topshot_offer_ask_spread to the rpc-insights-health artifact's surface list (Cowork can do that). Revert: delete the 4 new files + the 2 edits (git revert); the view/migrations can stay (harmless, no consumer) or DROP VIEW public.topshot_offer_ask_spread.

END STATE: a new public /insights/offer-spread surface live + crawlable, backed by the already-secured view, honest about the bid-vs-floor signal, mobile-safe table from day one. It extends the /insights distribution wedge with a signal no native Top Shot surface shows (the top bid relative to the floor ask).
