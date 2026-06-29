// app/api/public/insights/pack-reality/route.ts
//
// PUBLIC INSIGHTS — Top Shot Pack Reality.
//
// Read-only JSON endpoint backing the (planned) /insights/pack-reality page.
// Lives under /api/public/* so the proxy.ts allowlist lets it through with
// no auth. Reads from three public views shipped 2026-05-30 via
// audit_20260530_topshot_pack_reality_views_for_surface_b:
//
//   topshot_pack_reality_stats   — single-row 60d KPIs
//   topshot_pack_reality_dist    — pull-value histogram (6 buckets)
//   topshot_pack_reality_top_ev  — top +EV TS packs with a high-variance flag
//
// Why this exists: per the 2026-05-29 launch plan, "51% of TS pack rips
// deliver $0" is the headline counter-narrative to TS marketplace
// optimism. The dist view answers "how often do you actually pull
// something" and the top_ev view layers a high-variance flag so the
// "+EV" packs are presented with the right confidence caveats
// (fmv_coverage_pct < 80 → "EV is dragged by stale-priced moments").
//
// Query params:
//   limit=<1..100>          default 10, applies only to the top_ev list
//
// Response: { meta, stats, distribution, top_ev }
//
// CACHE: 5-minute s-maxage (pack_rips refreshes hourly; pack_ev_latest
// hourly via the pack-ev refresh cron — 5m well inside both windows).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? "10")));

  const [statsRes, distRes, topEvRes, realizedRes] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).from("topshot_pack_reality_stats").select("*").limit(1),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).from("topshot_pack_reality_dist").select("*"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("topshot_pack_reality_top_ev")
      .select(
        "pack_listing_id, dist_id, pack_name, pack_price, gross_ev, pack_ev, value_ratio, fmv_coverage_pct, edition_count, total_unopened, depletion_pct, snapshotted_at, price_source, high_variance, is_reward_pack, retail_price_usd_normalized, secondary_ask, secondary_available"
      )
      .limit(limit),
    // Per-dist modeled-EV-vs-realized reality check. Only dists with enough
    // opens to trust the realized side (n_opens >= 10). modeled_pack_price is
    // the clean price column (retail_price_usd carries raw satoshi values).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("v_topshot_pack_realized_ev")
      .select(
        "dist_id, title, modeled_pack_price, modeled_gross_ev, modeled_net_ev, price_source, n_opens, realized_mean, realized_median, realized_p10, realized_p90, realized_to_modeled_ratio, calibrated_ev"
      )
      .gte("n_opens", 10)
      .limit(1000),
  ]);

  if (statsRes.error) {
    console.error("[public/insights/pack-reality] stats", statsRes.error);
    return NextResponse.json({ error: statsRes.error.message }, { status: 500 });
  }
  if (distRes.error) {
    console.error("[public/insights/pack-reality] dist", distRes.error);
    return NextResponse.json({ error: distRes.error.message }, { status: 500 });
  }
  if (topEvRes.error) {
    console.error("[public/insights/pack-reality] top_ev", topEvRes.error);
    return NextResponse.json({ error: topEvRes.error.message }, { status: 500 });
  }
  if (realizedRes.error) {
    // Non-fatal: the model-vs-reality section degrades to empty, the rest of
    // the board still renders.
    console.error("[public/insights/pack-reality] realized", realizedRes.error);
  }

  // ── Model-vs-reality buckets ────────────────────────────────────────────
  // The modeled gross EV is occasionally a depleted-pool fossil (a $15 pack
  // showing a $565 modeled EV because its pool drained to a few high-FMV
  // editions). Guard the "over-modeled" cut so we never headline a fossil:
  // only include rows where the modeled EV is within 1.5× the pack price.
  type RealizedRow = {
    dist_id: string;
    title: string | null;
    modeled_pack_price: number | null;
    modeled_gross_ev: number | null;
    modeled_net_ev: number | null;
    price_source: string | null;
    n_opens: number | null;
    realized_mean: number | null;
    realized_median: number | null;
    realized_p10: number | null;
    realized_p90: number | null;
    realized_to_modeled_ratio: number | null;
    calibrated_ev: number | null;
  };
  const num = (v: unknown): number | null =>
    v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v);
  const realizedRows: RealizedRow[] = ((realizedRes.data ?? []) as RealizedRow[]).map((r) => ({
    ...r,
    modeled_pack_price: num(r.modeled_pack_price),
    modeled_gross_ev: num(r.modeled_gross_ev),
    modeled_net_ev: num(r.modeled_net_ev),
    realized_mean: num(r.realized_mean),
    realized_median: num(r.realized_median),
    realized_p10: num(r.realized_p10),
    realized_p90: num(r.realized_p90),
    realized_to_modeled_ratio: num(r.realized_to_modeled_ratio),
    calibrated_ev: num(r.calibrated_ev),
  }));

  const priced = realizedRows.filter(
    (r) => (r.modeled_pack_price ?? 0) > 0 && r.modeled_gross_ev != null
  );
  const nonFossil = (r: RealizedRow) =>
    r.modeled_gross_ev != null &&
    r.modeled_pack_price != null &&
    r.modeled_gross_ev <= r.modeled_pack_price * 1.5;

  const overModeled = priced
    .filter(
      (r) =>
        nonFossil(r) &&
        r.realized_to_modeled_ratio != null &&
        r.realized_to_modeled_ratio < 0.6 &&
        (r.modeled_gross_ev ?? 0) >= 10
    )
    .sort(
      (a, b) =>
        (a.realized_to_modeled_ratio ?? 99) - (b.realized_to_modeled_ratio ?? 99)
    )
    .slice(0, 8);

  const underModeled = priced
    .filter(
      (r) =>
        r.realized_to_modeled_ratio != null &&
        r.realized_to_modeled_ratio > 1.8 &&
        (r.modeled_gross_ev ?? 0) >= 0.5
    )
    .sort(
      (a, b) =>
        (b.realized_to_modeled_ratio ?? 0) - (a.realized_to_modeled_ratio ?? 0)
    )
    .slice(0, 8);

  const onModel = priced
    .filter(
      (r) =>
        r.realized_to_modeled_ratio != null &&
        r.realized_to_modeled_ratio >= 0.8 &&
        r.realized_to_modeled_ratio <= 1.25
    )
    .sort((a, b) => (b.n_opens ?? 0) - (a.n_opens ?? 0))
    .slice(0, 8);

  const elapsedMs = Date.now() - startedAt;
  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      sources: [
        "topshot_pack_reality_stats",
        "topshot_pack_reality_dist",
        "topshot_pack_reality_top_ev",
        "v_topshot_pack_realized_ev",
      ],
      elapsed_ms: elapsedMs,
      filters: { limit },
    },
    stats: statsRes.data?.[0] ?? null,
    distribution: distRes.data ?? [],
    top_ev: topEvRes.data ?? [],
    model_vs_reality: {
      qualifying_dists: realizedRows.length,
      over_modeled: overModeled,
      under_modeled: underModeled,
      on_model: onModel,
    },
  });

  res.headers.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");
  return res;
}
