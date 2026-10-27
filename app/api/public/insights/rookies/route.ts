// app/api/public/insights/rookies/route.ts
//
// PUBLIC INSIGHTS — 2025 NBA Rookie Class Index.
//
// Read-only JSON endpoint backing the (planned) /insights/rookies page.
// Lives under /api/public/* so the proxy.ts allowlist lets it through with
// no auth. Reads from two public views shipped 2026-05-30 via
// audit_20260530_topshot_rookie_index_views_for_surface_c:
//
//   topshot_2025_rookie_cohort_stats — single-row KPIs for the page header
//   topshot_2025_rookie_index        — per-player row (GMV 30d, lock-rate,
//                                      mint #1 trophy presence, etc.)
//
// Cohort = any player with at least one edition in a Series 8 rookie-themed
// set (Rookie Debut COMMON / Origins RARE / Rookie Revelation LEGENDARY /
// 2025 Rookie Ultimates ULTIMATE). 61 players in current data.
//
// Headline reference values (2026-05-30):
//   Dylan Harper:  GMV $21,360 / 30d, 80 sales, top sale $3,512
//   Kon Knueppel:  GMV $16,454 / 30d, avg $391.76, lock 54.6%
//   Cooper Flagg:  top mint-#1 sale $14,999
//   Cohort total:  $147,753 GMV / 30d, $51 avg active price
//
// 2026-10-22: `class=2026` reads the 2026 class (topshot_2026_rookie_index /
// _cohort_stats — the same bodies over the Series 9 Rookie Debut set, so it grows
// as that set mints). Any other value is a 400, never a silent 2025 answer.
//
// 2026-10-26: `class=nfl-2025` reads the 2025 NFL rookie class on NFL All Day (allday_2025_rookie_index /
// _cohort_stats — same columns; cohort = players with a Rookie Mint edition in All Day series 9). A class is a
// cohort, so All Day joins as one more class rather than a collection switch.
//
// Query params:
//   class=2025|2026|nfl-2025       default 2025
//   sort=gmv|lock|avg_price|sales  default gmv
//   limit=<1..100>                 default 100
//
// CACHE: 5-minute s-maxage.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { boardUnavailable } from "@/lib/insights/board-error";
import { boundedRead } from "@/lib/api/bounded-read";
import { ownLookup } from "@/lib/safe-lookup";

const VALID_SORTS = new Set(["gmv", "lock", "avg_price", "sales", "mint_one"]);
// Each class names its views explicitly — never a template over the param.
const CLASS_VIEWS = {
  "2025": { index: "topshot_2025_rookie_index", stats: "topshot_2025_rookie_cohort_stats" },
  "2026": { index: "topshot_2026_rookie_index", stats: "topshot_2026_rookie_cohort_stats" },
  "nfl-2025": { index: "allday_2025_rookie_index", stats: "allday_2025_rookie_cohort_stats" },
} as const;
const VALID_CLASSES = new Set(Object.keys(CLASS_VIEWS));

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const url = new URL(req.url);
  const sort = url.searchParams.get("sort") ?? "gmv";
  const cohortClass = url.searchParams.get("class") ?? "2025";
  const limitRaw = Number(url.searchParams.get("limit") ?? "100");
  const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? limitRaw : 100));

  if (!VALID_CLASSES.has(cohortClass)) {
    return NextResponse.json(
      { error: `class must be one of ${[...VALID_CLASSES].join(",")}` },
      { status: 400 }
    );
  }
  const views = ownLookup(CLASS_VIEWS, cohortClass);
  if (!views) {
    return NextResponse.json({ error: `class must be one of ${[...VALID_CLASSES].join(",")}` }, { status: 400 });
  }
  const indexView = views.index;
  const statsView = views.stats;

  if (!VALID_SORTS.has(sort)) {
    return NextResponse.json(
      { error: `sort must be one of ${[...VALID_SORTS].join(",")}` },
      { status: 400 }
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (supabase as any).from(indexView).select("*");
  if (sort === "gmv") q = q.order("gmv_30d", { ascending: false, nullsFirst: false });
  else if (sort === "lock") q = q.order("avg_lock_rate_pct", { ascending: false, nullsFirst: false });
  else if (sort === "avg_price")
    q = q.order("avg_price_30d", { ascending: false, nullsFirst: false });
  else if (sort === "sales") q = q.order("sales_30d", { ascending: false, nullsFirst: false });
  else if (sort === "mint_one")
    q = q.order("max_mint_one_sale_usd", { ascending: false, nullsFirst: false });
  q = q.limit(limit);

  const [statsRes, indexRes] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    boundedRead((supabase as any).from(statsView).select("*").limit(1), `api/public/insights/rookies/${statsView}`),
    boundedRead(q, `api/public/insights/rookies/${indexView}`),
  ]);

  if (statsRes.error) {
    return boardUnavailable(statsRes.error, "insights/rookies/stats");
  }
  if (indexRes.error) {
    return boardUnavailable(indexRes.error, "insights/rookies/index");
  }

  const elapsedMs = Date.now() - startedAt;
  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      sources: [statsView, indexView],
      elapsed_ms: elapsedMs,
      filters: { class: cohortClass, sort, limit },
    },
    cohort_stats: statsRes.data?.[0] ?? null,
    rows: indexRes.data ?? [],
  });

  res.headers.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");
  return res;
}
