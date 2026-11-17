// lib/insights/topshot-pack-reality.ts
//
// The Top Shot PACK REALITY read — the one body behind both
// GET /api/public/insights/pack-reality and the server-seeded first frame of
// /insights/pack-reality (review E2, 2026-10-13). Extracted VERBATIM from the
// route so the page and the API cannot drift: a crawler and a collector read the
// same five legs through the same per-leg degradation.
//
// Reads five surfaces (three MV-backed since 2026-08-02; measured 2.6 ms and
// 0.1 ms post-materialization — the figures are a dated sample):
//
//   topshot_pack_reality_stats              — single-row 60d KPIs
//   topshot_pack_reality_dist               — pull-value histogram (6 buckets)
//   topshot_pack_reality_top_ev             — top +EV TS packs with a high-variance flag
//   v_topshot_pack_realized_ev              — per-dist modeled-vs-realized EV (n_opens >= 10)
//   v_topshot_pack_reality_ranker_staleness — why an empty ranker is empty (#118)
//
// PARTIAL FAILURE IS NOT AN OUTAGE. Each of the four named legs degrades
// independently and is NAMED in `errors`; `totalOutage` is true only when all
// four failed. The staleness leg is deliberately never fatal — if it fails we
// simply cannot explain an empty board, which is the status quo.
//
// ⚠ The `db` client is a PARAMETER, defaulted, so a server page can route the
// read through `fetchBoardForPage` (which supplies the client and bounds the
// wait) without importing `@/lib/supabase` itself — the property the
// server-page data-access ratchet keys on.

import { safeApiError } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { supabaseAdmin } from "@/lib/supabase"

export const TOPSHOT_PACK_REALITY_SOURCES = [
  "topshot_pack_reality_stats",
  "topshot_pack_reality_dist",
  "topshot_pack_reality_top_ev",
  "v_topshot_pack_realized_ev",
] as const

export type PackRealityLegError = { source: string; message: string }

export type RealizedRow = {
  dist_id: string
  title: string | null
  modeled_pack_price: number | null
  modeled_gross_ev: number | null
  modeled_net_ev: number | null
  price_source: string | null
  n_opens: number | null
  realized_mean: number | null
  realized_median: number | null
  realized_p10: number | null
  realized_p90: number | null
  realized_to_modeled_ratio: number | null
  calibrated_ev: number | null
}

export type RankerStaleness = {
  stale_count: number
  newest_qualifying_snapshot: string | null
  candidates_considered: number | null
  candidates_adjudicated: number | null
  verdict_complete: boolean | null
}

/** The JSON body the public route returns on a non-outage read. */
export type TopshotPackRealityBody = {
  meta: {
    fetched_at: string
    sources: readonly string[]
    elapsed_ms: number
    filters: { limit: number }
    errors: PackRealityLegError[]
    ranker_staleness: RankerStaleness | null
    /** Why `ranker_staleness` is what it is: `not_needed` = the ranker had rows (or failed to load), so nothing was read. */
    ranker_staleness_status: "not_needed" | "read" | "failed"
  }
  stats: Record<string, unknown> | null
  distribution: Record<string, unknown>[]
  top_ev: Record<string, unknown>[]
  model_vs_reality: {
    qualifying_dists: number
    over_modeled: RealizedRow[]
    under_modeled: RealizedRow[]
    on_model: RealizedRow[]
  }
}

export type TopshotPackRealityRead =
  | { totalOutage: false; body: TopshotPackRealityBody; errors: PackRealityLegError[] }
  /** All four named legs failed. `error` is the first leg's driver error, for classification. */
  | { totalOutage: true; error: unknown; errors: PackRealityLegError[] }

/** Clamp a raw `limit` the way the route always has: 1..100, default 10. */
export function clampPackRealityLimit(raw: string | null | undefined): number {
  const n = Number(raw ?? "10")
  return Math.max(1, Math.min(100, Number.isFinite(n) ? n : 10))
}

export async function readTopshotPackReality(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
  limit = 10,
): Promise<TopshotPackRealityRead> {
  const startedAt = Date.now()
  const supabase = db

  const [statsRes, distRes, topEvRes, realizedRes] = await Promise.all([
    boundedRead(supabase.from("topshot_pack_reality_stats").select("*").limit(1), "api/public/insights/pack-reality/topshot_pack_reality_stats"),
    boundedRead(supabase.from("topshot_pack_reality_dist").select("*"), "api/public/insights/pack-reality/topshot_pack_reality_dist"),
    boundedRead(supabase
      .from("topshot_pack_reality_top_ev")
      .select(
        "pack_listing_id, dist_id, pack_name, pack_price, gross_ev, pack_ev, value_ratio, fmv_coverage_pct, edition_count, total_unopened, depletion_pct, snapshotted_at, price_source, high_variance, is_reward_pack, retail_price_usd_normalized, secondary_ask, secondary_available"
      )
      .limit(limit), "api/public/insights/pack-reality/topshot_pack_reality_top_ev"),
    // Per-dist modeled-EV-vs-realized reality check. Only dists with enough
    // opens to trust the realized side (n_opens >= 10). modeled_pack_price is
    // the clean price column (retail_price_usd carries raw satoshi values).
    boundedRead(supabase
      .from("v_topshot_pack_realized_ev")
      .select(
        "dist_id, title, modeled_pack_price, modeled_gross_ev, modeled_net_ev, price_source, n_opens, realized_mean, realized_median, realized_p10, realized_p90, realized_to_modeled_ratio, calibrated_ev"
      )
      .gte("n_opens", 10)
      .limit(1000), "api/public/insights/pack-reality/v_topshot_pack_realized_ev"),
  ])

  // Why the +EV ranker is empty, when it is empty. The board's own zero rows
  // cannot distinguish "nothing qualifies" (an honest market answer) from
  // "everything that qualifies is stale" (a claim about OUR pipeline) — and on
  // 2026-09-01 it was the second: 3 packs passed every filter and were 107-130h
  // old, so the 48h freshness clause emptied the board while the page said
  // "No +EV packs right now." This view is that MV's filter minus the freshness
  // clause. It is DELIBERATELY not fatal: if it fails we simply cannot explain
  // an empty board, which is the status quo, not a regression.
  //
  // 2026-10-15: read ONLY when the ranker loaded and came back EMPTY — the one
  // case its answer is used (the page ignores it otherwise). It ran on every
  // read: ~290/day at ~2.7 s, ~20k blocks and a ~52 MB on-disk sort each (it
  // re-derives the latest row per listing across every collection), while the
  // ranker held rows and the answer was discarded. `ranker_staleness_status`
  // keeps "not needed" apart from "failed", which both leave the object null.
  const rankerNeedsExplaining = topEvRes.error == null && (topEvRes.data ?? []).length === 0
  const rankerStaleRes = rankerNeedsExplaining
    ? await boundedRead(supabase.from("v_topshot_pack_reality_ranker_staleness").select("*").limit(1), "api/public/insights/pack-reality/v_topshot_pack_reality_ranker_staleness")
    : null

  // PARTIAL FAILURE IS NOT A 500. Until 2026-08-02 the first three legs were
  // each FATAL, so one slow view took the WHOLE board down: the page rendered
  // "FAILED TO LOAD: HTTP 500" with every KPI as an em-dash while the other
  // surfaces were healthy. Degrade per leg instead, and NAME the failed
  // surfaces in meta.errors so the client can say "temporarily unavailable"
  // rather than quietly rendering an empty board (same treatment as the
  // 2026-08-02 /insights/market loadError fix). A TOTAL outage stays a loud
  // 500 — a fully empty board returned as 200 would be the silent lie.
  const errors: PackRealityLegError[] = []
  const noteError = (source: string, err: { message?: string } | null | undefined) => {
    if (!err) return
    // Detail to the LOG only. `message` used to carry the driver's own text
    // (`err.message`) and this array is published as meta.errors on the public
    // 200 response — the deep-audit D3 leak, on an anon-readable route. The one
    // consumer (the page) reads only `e.source` and maps it to a label, so the
    // raw message was never load-bearing; it is replaced with classified copy
    // rather than dropped, to keep the shape.
    console.error(`[public/insights/pack-reality] ${source}`, err)
    errors.push({ source, message: safeApiError(err, "unavailable").error })
  }
  noteError("topshot_pack_reality_stats", statsRes.error)
  noteError("topshot_pack_reality_dist", distRes.error)
  noteError("topshot_pack_reality_top_ev", topEvRes.error)
  noteError("v_topshot_pack_realized_ev", realizedRes.error)

  if (errors.length === 4) {
    return { totalOutage: true, error: statsRes.error ?? distRes.error, errors }
  }

  // ── Model-vs-reality buckets ────────────────────────────────────────────
  // The modeled gross EV is occasionally a depleted-pool fossil (a $15 pack
  // showing a $565 modeled EV because its pool drained to a few high-FMV
  // editions). Guard the "over-modeled" cut so we never headline a fossil:
  // only include rows where the modeled EV is within 1.5× the pack price.
  const num = (v: unknown): number | null =>
    v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v)
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
  }))

  const priced = realizedRows.filter(
    (r) => (r.modeled_pack_price ?? 0) > 0 && r.modeled_gross_ev != null
  )
  const nonFossil = (r: RealizedRow) =>
    r.modeled_gross_ev != null &&
    r.modeled_pack_price != null &&
    r.modeled_gross_ev <= r.modeled_pack_price * 1.5

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
    .slice(0, 8)

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
    .slice(0, 8)

  const onModel = priced
    .filter(
      (r) =>
        r.realized_to_modeled_ratio != null &&
        r.realized_to_modeled_ratio >= 0.8 &&
        r.realized_to_modeled_ratio <= 1.25
    )
    .sort((a, b) => (b.n_opens ?? 0) - (a.n_opens ?? 0))
    .slice(0, 8)

  // ── Why an empty ranker is empty ────────────────────────────────────────
  // Only meaningful when top_ev is empty AND the read succeeded. `stale_count`
  // is how many packs pass every ranker filter but the 48h freshness one; when
  // that is > 0 and the board is empty, the emptiness is OUR staleness, not the
  // market's, and the client must not say "No +EV packs right now."
  // ⚠ null when this leg failed — the client then falls back to the old copy,
  // which is the status quo rather than a new false claim.
  const staleRow = (rankerStaleRes?.data?.[0] ?? null) as {
    qualifying_ignoring_freshness?: number | null
    newest_qualifying_snapshot?: string | null
    candidates_considered?: number | null
    candidates_adjudicated?: number | null
  } | null
  if (rankerStaleRes?.error) {
    console.error("[public/insights/pack-reality] v_topshot_pack_reality_ranker_staleness", rankerStaleRes.error)
  }
  // 2026-09-20 (#118): `stale_count` is now ADJUDICATED, not assumed — the view
  // recomputes each candidate's EV live and requires the pack to be listed right
  // now, so "N packs would otherwise qualify" is a measurement. Measured the day
  // it shipped: 3 candidates, only 2 still qualifying (dist 7812 had moved from
  // +7.73 to -1.68 since its August snapshot), so the old count overstated by one
  // in the direction that flatters a buy.
  //
  // ⚠ `verdict_complete` is the half a caller would otherwise have no way to see.
  // The view caps its live recomputation at 60 candidates because each one costs a
  // compute_pack_ev_per_edition_weighted call; past that, `stale_count` is a LOWER
  // BOUND. A partial count that cannot be told from a complete one is the exact
  // defect this whole panel exists to prevent, so the cap travels with the number.
  // ⛔ Do not collapse this to a bare boolean derived elsewhere — it must come from
  // the same row as the count it qualifies.
  const rankerStaleness: RankerStaleness | null =
    staleRow == null
      ? null
      : {
          stale_count: Number(staleRow.qualifying_ignoring_freshness ?? 0),
          newest_qualifying_snapshot: staleRow.newest_qualifying_snapshot ?? null,
          candidates_considered:
            staleRow.candidates_considered == null ? null : Number(staleRow.candidates_considered),
          candidates_adjudicated:
            staleRow.candidates_adjudicated == null ? null : Number(staleRow.candidates_adjudicated),
          verdict_complete:
            staleRow.candidates_considered == null || staleRow.candidates_adjudicated == null
              ? null
              : Number(staleRow.candidates_considered) === Number(staleRow.candidates_adjudicated),
        }

  const body: TopshotPackRealityBody = {
    meta: {
      fetched_at: new Date().toISOString(),
      sources: TOPSHOT_PACK_REALITY_SOURCES,
      elapsed_ms: Date.now() - startedAt,
      filters: { limit },
      errors,
      ranker_staleness: rankerStaleness,
      ranker_staleness_status: rankerStaleRes == null ? "not_needed" : rankerStaleRes.error ? "failed" : "read",
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
  }
  return { totalOutage: false, body, errors }
}
