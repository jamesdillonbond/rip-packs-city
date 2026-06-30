// app/api/public/insights/allday-pack-market/route.ts
//
// PUBLIC INSIGHTS — NFL All Day Pack Market (sealed-pack secondary resale).
//
// Read-only JSON endpoint backing /insights/allday-pack-market. Lives under
// /api/public/* so the proxy.ts allowlist lets it through with no auth.
//
// Reads the public view v_allday_pack_market — the complete sealed-pack
// secondary sale history (Dapper Studio Platform, backfilling to AllDay's 2022
// genesis) rolled up per dist: median / last / count + the premium-or-discount
// vs the original retail price. What a SEALED pack actually trades for, which
// Top Shot's own site never surfaces cleanly.
//
// Gating: n_sales >= 5 so the resale signal is stable. Discount/premium buckets
// require a real retail price (reward/airdrop packs have retail 0 → null ratio,
// so they only appear in the most-traded bucket).
//
// CACHE: 5-minute s-maxage (the sales backfill cron runs */3, the view is a
// cheap index-driven rollup — 5m is well inside the freshness window).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

const MIN_SALES = 5;

type MarketRow = {
  dist_id: string;
  title: string | null;
  drop_size: number | null;
  retail_price: number | null;
  opened_pct_of_minted: number | null;
  n_sales: number | null;
  n_sales_30d: number | null;
  n_sales_90d: number | null;
  last_sale_price: number | null;
  last_sale_at: string | null;
  median_price_90d: number | null;
  avg_price_90d: number | null;
  min_price_all: number | null;
  max_price_all: number | null;
  secondary_vs_retail_ratio: number | null;
};

const num = (v: unknown): number | null =>
  v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v);

export async function GET(_req: NextRequest) {
  const startedAt = Date.now();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("v_allday_pack_market")
    .select(
      "dist_id, title, drop_size, retail_price, opened_pct_of_minted, n_sales, n_sales_30d, n_sales_90d, last_sale_price, last_sale_at, median_price_90d, avg_price_90d, min_price_all, max_price_all, secondary_vs_retail_ratio"
    )
    .gte("n_sales", MIN_SALES)
    .limit(1000);

  if (error) {
    console.error("[public/insights/allday-pack-market] market", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows: MarketRow[] = ((data ?? []) as MarketRow[]).map((r) => ({
    ...r,
    drop_size: num(r.drop_size),
    retail_price: num(r.retail_price),
    opened_pct_of_minted: num(r.opened_pct_of_minted),
    n_sales: num(r.n_sales),
    n_sales_30d: num(r.n_sales_30d),
    n_sales_90d: num(r.n_sales_90d),
    last_sale_price: num(r.last_sale_price),
    median_price_90d: num(r.median_price_90d),
    avg_price_90d: num(r.avg_price_90d),
    min_price_all: num(r.min_price_all),
    max_price_all: num(r.max_price_all),
    secondary_vs_retail_ratio: num(r.secondary_vs_retail_ratio),
  }));

  // Discount/premium buckets require a real retail price → a non-null ratio.
  const priced = rows.filter(
    (r) => (r.retail_price ?? 0) > 0 && r.secondary_vs_retail_ratio != null
  );

  const biggestDiscount = priced
    .filter((r) => (r.secondary_vs_retail_ratio ?? 1) < 0.85)
    .sort(
      (a, b) =>
        (a.secondary_vs_retail_ratio ?? 9) - (b.secondary_vs_retail_ratio ?? 9)
    )
    .slice(0, 15);

  const biggestPremium = priced
    .filter((r) => (r.secondary_vs_retail_ratio ?? 0) > 1.15)
    .sort(
      (a, b) =>
        (b.secondary_vs_retail_ratio ?? 0) - (a.secondary_vs_retail_ratio ?? 0)
    )
    .slice(0, 15);

  const mostTraded = rows
    .slice()
    .sort((a, b) => (b.n_sales ?? 0) - (a.n_sales ?? 0))
    .slice(0, 15);

  // Freshness = newest sale across the qualifying set.
  const lastSaleAt = rows
    .map((r) => r.last_sale_at)
    .filter((d): d is string => !!d)
    .sort()
    .pop() ?? null;

  const elapsedMs = Date.now() - startedAt;
  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      last_sale_at: lastSaleAt,
      sources: ["v_allday_pack_market"],
      elapsed_ms: elapsedMs,
      filters: { min_sales: MIN_SALES },
    },
    market: {
      qualifying_dists: rows.length,
      biggest_discount: biggestDiscount,
      biggest_premium: biggestPremium,
      most_traded: mostTraded,
    },
  });

  res.headers.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");
  return res;
}
