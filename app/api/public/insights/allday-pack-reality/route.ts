// app/api/public/insights/allday-pack-reality/route.ts
//
// PUBLIC INSIGHTS — NFL All Day Pack Reality (model vs realized pulls).
//
// Read-only JSON endpoint backing /insights/allday-pack-reality. Lives under
// /api/public/* so the proxy.ts allowlist lets it through with no auth.
//
// Reads the public view v_allday_pack_realized_ev — the AllDay sibling of
// v_topshot_pack_realized_ev. Per dist it compares the odds/median-corrected
// modeled EV against what opened packs ACTUALLY pulled (realized pull value,
// resolved on-chain). The "model says $X, packs actually pull $Y" honesty cut.
//
// Gating (matches the handoff): n_opens >= 5 so the realized side is stable,
// and low_confidence_ev excluded so thin/stale-FMV dists don't headline. The
// view is sparse today (it populates as resolve-allday-pack-dist attributes
// opened packs to PAID dists) — the page degrades to an honest empty state.
//
// CACHE: 5-minute s-maxage (AllDay pack opens ingest ~hourly; realized rollup
// + corrected EV refresh on cron — 5m well inside both windows).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

const MIN_OPENS = 5;

type RealizedRow = {
  dist_id: string;
  title: string | null;
  pack_price: number | null;
  modeled_gross_ev: number | null;
  ev_method: string | null;
  low_confidence_ev: boolean | null;
  n_opens: number | null;
  n_valued: number | null;
  realized_mean: number | null;
  realized_median: number | null;
  realized_total: number | null;
  realized_to_modeled_ratio: number | null;
};

const num = (v: unknown): number | null =>
  v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v);

export async function GET(_req: NextRequest) {
  const startedAt = Date.now();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("v_allday_pack_realized_ev")
    .select(
      "dist_id, title, pack_price, modeled_gross_ev, ev_method, low_confidence_ev, n_opens, n_valued, realized_mean, realized_median, realized_total, realized_to_modeled_ratio"
    )
    .gte("n_opens", MIN_OPENS)
    .eq("low_confidence_ev", false)
    .limit(1000);

  if (error) {
    console.error("[public/insights/allday-pack-reality] realized", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows: RealizedRow[] = ((data ?? []) as RealizedRow[]).map((r) => ({
    ...r,
    pack_price: num(r.pack_price),
    modeled_gross_ev: num(r.modeled_gross_ev),
    n_opens: num(r.n_opens),
    n_valued: num(r.n_valued),
    realized_mean: num(r.realized_mean),
    realized_median: num(r.realized_median),
    realized_total: num(r.realized_total),
    realized_to_modeled_ratio: num(r.realized_to_modeled_ratio),
  }));

  const priced = rows.filter(
    (r) => (r.pack_price ?? 0) > 0 && r.modeled_gross_ev != null
  );
  // Guard against depleted-pool fossils: a corrected modeled EV many multiples
  // above the pack price is a survivor-bias artefact, not a headline.
  const nonFossil = (r: RealizedRow) =>
    r.modeled_gross_ev != null &&
    r.pack_price != null &&
    r.modeled_gross_ev <= r.pack_price * 1.5;

  const overModeled = priced
    .filter(
      (r) =>
        nonFossil(r) &&
        r.realized_to_modeled_ratio != null &&
        r.realized_to_modeled_ratio < 0.6 &&
        (r.modeled_gross_ev ?? 0) >= 2
    )
    .sort(
      (a, b) =>
        (a.realized_to_modeled_ratio ?? 99) - (b.realized_to_modeled_ratio ?? 99)
    )
    .slice(0, 12);

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
    .slice(0, 12);

  const onModel = priced
    .filter(
      (r) =>
        r.realized_to_modeled_ratio != null &&
        r.realized_to_modeled_ratio >= 0.8 &&
        r.realized_to_modeled_ratio <= 1.25
    )
    .sort((a, b) => (b.n_opens ?? 0) - (a.n_opens ?? 0))
    .slice(0, 12);

  const elapsedMs = Date.now() - startedAt;
  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      sources: ["v_allday_pack_realized_ev"],
      elapsed_ms: elapsedMs,
      filters: { min_opens: MIN_OPENS, exclude_low_confidence: true },
    },
    model_vs_reality: {
      qualifying_dists: priced.length,
      over_modeled: overModeled,
      under_modeled: underModeled,
      on_model: onModel,
    },
  });

  res.headers.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");
  return res;
}
