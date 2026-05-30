// app/api/public/insights/squeeze/route.ts
//
// PUBLIC INSIGHTS — Top Shot lock-rate squeeze board.
//
// Read-only JSON endpoint backing the (planned) /insights/squeeze page.
// Lives under /api/public/* so the proxy.ts allowlist lets it through with
// no auth. Reads from the public `topshot_squeeze_board` view (shipped
// 2026-05-30 via `audit_20260530_topshot_squeeze_board_view`) which joins
// badge_editions (hourly refresh) + editions + latest fmv_snapshots and
// filters to squeeze_pct >= 50.
//
// Why this exists: per the 2026-05-29 Flow collection research thread,
// effective-supply squeeze (locked + burned %) is the single biggest
// under-told story on Top Shot. nbatopshot.com displays nominal
// circulation, not effective supply. Wemby Rookie Revelation = 81% locked.
// Origins rookies averaging 60-65% locked. Median TS edition is 38.6%
// locked. This route surfaces the squeeze ranking in a shape an OG-friendly
// page can render without auth.
//
// Query params:
//   tier=COMMON|RARE|LEGENDARY|FANDOM|ULTIMATE        single tier filter
//   min_squeeze=<number>                              floor on squeeze_pct (default 50)
//   max_buyable=<number>                              cap on effectively_buyable (e.g. 10 for trophy-tier)
//   set=<text>                                        ilike match on set_name
//   sort=squeeze|circulation|fmv|buyable              default squeeze
//   limit=<1..200>                                    default 50
//
// Response:
//   {
//     meta: { fetchedAt, source: "topshot_squeeze_board", total_rows, filters: {...} },
//     rows: [{ edition_id, external_id, player_name, set_name, tier, circulation,
//              locked, burned, lock_pct, burn_pct, squeeze_pct, effectively_buyable,
//              low_ask, fmv_usd, confidence, game_date, thumbnail_url }, ...]
//   }
//
// CACHE: 5-minute s-maxage matches the hourly cadence of badge_editions
// without re-querying on every page hit.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

const VALID_TIERS = new Set(["COMMON", "RARE", "LEGENDARY", "FANDOM", "ULTIMATE"]);
const VALID_SORTS = new Set(["squeeze", "circulation", "fmv", "buyable"]);

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const url = new URL(req.url);
  const sp = url.searchParams;

  const tier = sp.get("tier")?.toUpperCase() ?? null;
  const minSqueeze = Number(sp.get("min_squeeze") ?? "50");
  const maxBuyable = sp.get("max_buyable") ? Number(sp.get("max_buyable")) : null;
  const setFilter = sp.get("set")?.trim() ?? null;
  // Optional: limit to "trophy circ" editions (e.g. max_circulation=100
  // surfaces only Ultimate/Legendary tier editions).
  const maxCirculation = sp.get("max_circulation") ? Number(sp.get("max_circulation")) : null;
  const sort = sp.get("sort") ?? "squeeze";
  const limit = Math.max(1, Math.min(200, Number(sp.get("limit") ?? "50")));

  if (tier && !VALID_TIERS.has(tier)) {
    return NextResponse.json(
      { error: `tier must be one of ${[...VALID_TIERS].join(",")}` },
      { status: 400 }
    );
  }
  if (!Number.isFinite(minSqueeze) || minSqueeze < 0) {
    return NextResponse.json({ error: "min_squeeze must be a non-negative number" }, { status: 400 });
  }
  if (!VALID_SORTS.has(sort)) {
    return NextResponse.json(
      { error: `sort must be one of ${[...VALID_SORTS].join(",")}` },
      { status: 400 }
    );
  }

  let q = (supabase as any)
    .from("topshot_squeeze_board")
    .select(
      "edition_id, external_id, player_name, set_name, tier, circulation, locked, burned, lock_pct, burn_pct, squeeze_pct, effectively_buyable, low_ask, fmv_usd, confidence, game_date, thumbnail_url"
    )
    .gte("squeeze_pct", minSqueeze);

  if (tier) q = q.eq("tier", tier);
  if (setFilter) q = q.ilike("set_name", `%${setFilter}%`);
  if (maxBuyable != null && Number.isFinite(maxBuyable)) {
    q = q.lte("effectively_buyable", maxBuyable);
  }
  if (maxCirculation != null && Number.isFinite(maxCirculation)) {
    q = q.lte("circulation", maxCirculation);
  }

  // Sort: squeeze_pct DESC is the canonical "most squeezed first" ranking.
  // Secondary by ASC circulation so trophy-circ editions surface above
  // commons at the same squeeze pct.
  if (sort === "squeeze") {
    q = q.order("squeeze_pct", { ascending: false }).order("circulation", { ascending: true });
  } else if (sort === "circulation") {
    q = q.order("circulation", { ascending: true }).order("squeeze_pct", { ascending: false });
  } else if (sort === "fmv") {
    q = q.order("fmv_usd", { ascending: false, nullsFirst: false }).order("squeeze_pct", { ascending: false });
  } else if (sort === "buyable") {
    q = q.order("effectively_buyable", { ascending: true }).order("squeeze_pct", { ascending: false });
  }

  q = q.limit(limit);

  const { data, error } = await q;
  if (error) {
    console.error("[public/insights/squeeze]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[public/insights/squeeze] returned=${data?.length ?? 0} tier=${tier ?? "*"} min_squeeze=${minSqueeze} sort=${sort} elapsedMs=${elapsedMs}`
  );

  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "topshot_squeeze_board",
      total_rows: data?.length ?? 0,
      elapsed_ms: elapsedMs,
      filters: {
        tier,
        min_squeeze: minSqueeze,
        max_buyable: maxBuyable,
        max_circulation: maxCirculation,
        set: setFilter,
        sort,
        limit,
      },
    },
    rows: data ?? [],
  });

  // 5-minute edge cache. badge_editions refreshes hourly so 5m is well
  // inside the freshness window and protects the DB from a viral OG-share spike.
  res.headers.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");
  return res;
}
