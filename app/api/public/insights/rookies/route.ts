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
// Query params:
//   sort=gmv|lock|avg_price|sales  default gmv
//   limit=<1..100>                 default 100
//
// CACHE: 5-minute s-maxage.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

const VALID_SORTS = new Set(["gmv", "lock", "avg_price", "sales", "mint_one"]);

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const url = new URL(req.url);
  const sort = url.searchParams.get("sort") ?? "gmv";
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? "100")));

  if (!VALID_SORTS.has(sort)) {
    return NextResponse.json(
      { error: `sort must be one of ${[...VALID_SORTS].join(",")}` },
      { status: 400 }
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (supabase as any).from("topshot_2025_rookie_index").select("*");
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
    (supabase as any).from("topshot_2025_rookie_cohort_stats").select("*").limit(1),
    q,
  ]);

  if (statsRes.error) {
    console.error("[public/insights/rookies] stats", statsRes.error);
    return NextResponse.json({ error: statsRes.error.message }, { status: 500 });
  }
  if (indexRes.error) {
    console.error("[public/insights/rookies] index", indexRes.error);
    return NextResponse.json({ error: indexRes.error.message }, { status: 500 });
  }

  const elapsedMs = Date.now() - startedAt;
  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      sources: [
        "topshot_2025_rookie_cohort_stats",
        "topshot_2025_rookie_index",
      ],
      elapsed_ms: elapsedMs,
      filters: { sort, limit },
    },
    cohort_stats: statsRes.data?.[0] ?? null,
    rows: indexRes.data ?? [],
  });

  res.headers.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");
  return res;
}
