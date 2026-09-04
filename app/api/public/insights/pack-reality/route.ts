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
//   meta.errors names any backing surface that failed THIS request. Each leg
//   degrades independently (2026-08-02); only an all-four outage returns 500.
//
// PERF (2026-08-02): stats + top_ev are MV-backed
// (audit_20260802_pack_reality_stats_and_top_ev_materialize) after both were
// measured able to exceed the 30s service_role budget on their own — 9,468 ms /
// 41,923 ms and 823 ms / 53,003 ms warm / contended — which made this route a
// guaranteed 500. Post-materialization: 2.6 ms and 0.1 ms.
//
// CACHE: 5-minute s-maxage (pack_rips refreshes hourly; pack_ev_latest
// hourly via the pack-ev refresh cron — 5m well inside both windows).

import { NextRequest, NextResponse } from "next/server";
import { boardUnavailable } from "@/lib/insights/board-error";
import { safeApiError } from "@/lib/api-error";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { boundedRead } from "@/lib/api/bounded-read";

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? "10");
  const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? limitRaw : 10));

  const [statsRes, distRes, topEvRes, realizedRes, rankerStaleRes] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    boundedRead((supabase as any).from("topshot_pack_reality_stats").select("*").limit(1), "api/public/insights/pack-reality/topshot_pack_reality_stats"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    boundedRead((supabase as any).from("topshot_pack_reality_dist").select("*"), "api/public/insights/pack-reality/topshot_pack_reality_dist"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    boundedRead((supabase as any)
      .from("topshot_pack_reality_top_ev")
      .select(
        "pack_listing_id, dist_id, pack_name, pack_price, gross_ev, pack_ev, value_ratio, fmv_coverage_pct, edition_count, total_unopened, depletion_pct, snapshotted_at, price_source, high_variance, is_reward_pack, retail_price_usd_normalized, secondary_ask, secondary_available"
      )
      .limit(limit), "api/public/insights/pack-reality/topshot_pack_reality_top_ev"),
    // Per-dist modeled-EV-vs-realized reality check. Only dists with enough
    // opens to trust the realized side (n_opens >= 10). modeled_pack_price is
    // the clean price column (retail_price_usd carries raw satoshi values).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    boundedRead((supabase as any)
      .from("v_topshot_pack_realized_ev")
      .select(
        "dist_id, title, modeled_pack_price, modeled_gross_ev, modeled_net_ev, price_source, n_opens, realized_mean, realized_median, realized_p10, realized_p90, realized_to_modeled_ratio, calibrated_ev"
      )
      .gte("n_opens", 10)
      .limit(1000), "api/public/insights/pack-reality/v_topshot_pack_realized_ev"),
    // Why the +EV ranker is empty, when it is empty. The board's own zero rows
    // cannot distinguish "nothing qualifies" (an honest market answer) from
    // "everything that qualifies is stale" (a claim about OUR pipeline) — and on
    // 2026-09-01 it was the second: 3 packs passed every filter and were 107-130h
    // old, so the 48h freshness clause emptied the board while the page said
    // "No +EV packs right now." This view is that MV's filter minus the freshness
    // clause. It is DELIBERATELY not fatal: if it fails we simply cannot explain
    // an empty board, which is the status quo, not a regression.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    boundedRead((supabase as any).from("v_topshot_pack_reality_ranker_staleness").select("*").limit(1), "api/public/insights/pack-reality/v_topshot_pack_reality_ranker_staleness"),
  ]);

  // PARTIAL FAILURE IS NOT A 500. Until 2026-08-02 the first three legs were
  // each FATAL, so one slow view took the WHOLE board down: the page rendered
  // "FAILED TO LOAD: HTTP 500" with every KPI as an em-dash while the other
  // surfaces were healthy. Degrade per leg instead, and NAME the failed
  // surfaces in meta.errors so the client can say "temporarily unavailable"
  // rather than quietly rendering an empty board (same treatment as the
  // 2026-08-02 /insights/market loadError fix). A TOTAL outage stays a loud
  // 500 — a fully empty board returned as 200 would be the silent lie.
  const errors: { source: string; message: string }[] = [];
  const noteError = (source: string, err: { message?: string } | null | undefined) => {
    if (!err) return;
    // Detail to the LOG only. `message` used to carry the driver's own text
    // (`err.message`) and this array is published as meta.errors on the public
    // 200 response — the deep-audit D3 leak, on an anon-readable route. The one
    // consumer (app/insights/pack-reality/page.tsx) reads only `e.source` and
    // maps it to a label, so the raw message was never load-bearing; it is
    // replaced with classified copy rather than dropped, to keep the shape.
    console.error(`[public/insights/pack-reality] ${source}`, err);
    errors.push({ source, message: safeApiError(err, "unavailable").error });
  };
  noteError("topshot_pack_reality_stats", statsRes.error);
  noteError("topshot_pack_reality_dist", distRes.error);
  noteError("topshot_pack_reality_top_ev", topEvRes.error);
  noteError("v_topshot_pack_realized_ev", realizedRes.error);

  if (errors.length === 4) {
    // Total outage stays loud, but classified: a statement timeout becomes a
    // retryable 503 rather than a 500 carrying Postgres's own wording.
    return boardUnavailable(statsRes.error ?? distRes.error, "insights/pack-reality");
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

  // ── Why an empty ranker is empty ────────────────────────────────────────
  // Only meaningful when top_ev is empty AND the read succeeded. `stale_count`
  // is how many packs pass every ranker filter but the 48h freshness one; when
  // that is > 0 and the board is empty, the emptiness is OUR staleness, not the
  // market's, and the client must not say "No +EV packs right now."
  // ⚠ null when this leg failed — the client then falls back to the old copy,
  // which is the status quo rather than a new false claim.
  const staleRow = (rankerStaleRes.data?.[0] ?? null) as {
    qualifying_ignoring_freshness?: number | null;
    newest_qualifying_snapshot?: string | null;
  } | null;
  if (rankerStaleRes.error) {
    console.error("[public/insights/pack-reality] v_topshot_pack_reality_ranker_staleness", rankerStaleRes.error);
  }
  const rankerStaleness =
    staleRow == null
      ? null
      : {
          stale_count: Number(staleRow.qualifying_ignoring_freshness ?? 0),
          newest_qualifying_snapshot: staleRow.newest_qualifying_snapshot ?? null,
        };

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
      errors,
      ranker_staleness: rankerStaleness,
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
