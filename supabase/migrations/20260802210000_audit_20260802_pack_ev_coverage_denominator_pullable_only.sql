-- audit_20260802_pack_ev_coverage_denominator_pullable_only
--
-- CAUSE
--   public.compute_pack_ev_per_edition_weighted derived
--     fmv_coverage_pct = 100 * editions_with_fmv / edition_count
--   where BOTH counts were taken over every pack_drop_pool row for the distribution,
--   INCLUDING rows exhausted to zero weight. Those editions can no longer be pulled
--   from the pack, so the published coverage figure described a pool that no longer
--   exists. `edition_count` itself (also published, and persisted to
--   pack_ev_latest.edition_count) had the same problem.
--
-- EVIDENCE (measured live 2026-08-02)
--   pack_drop_pool zero-weight rows by collection:
--     nba_top_shot   28,648 of 60,993 rows  (667 of 1,360 distributions affected)
--     nfl_all_day         0 of 89,783 rows
--     laliga_golazos      0 of  1,957 rows
--   So the dilution is Top-Shot-only in practice. Measured effect on the published
--   number is real but small, because TS FMV coverage is near-total:
--     avg fmv_coverage_pct  99.9% -> 99.9%
--     max per-dist change   +6.3 pts / -4.5 pts
--     distributions crossing the 80% publication threshold in either direction: 0
--   This is therefore a correctness fix, not a repricing.
--
-- FIX
--   Count only PULLABLE editions -- weight > 0 under the basis actually in use
--   (orig_drop_weight when ev_basis='original', drop_weight when 'remaining'), so the
--   denominator is always consistent with the weights the EV was computed from.
--   A new v_pool_rows_total keeps the unfiltered count so the `pool_empty` guard
--   returns in exactly the same cases as before. `pool_rows_total` is added to the
--   returned jsonb for auditability.
--
-- EV-NEUTRAL BY CONSTRUCTION
--   A zero-weight row contributes 0 to the numerator and 0 to the denominator of every
--   weighted aggregate in the function, and the median CTE already filtered `w > 0`.
--   gross_ev, typical_pull_ev, typical_per_slot, pack_ev, value_ratio,
--   total_pool_weight, covered_pool_weight and weighted_fmv_coverage_pct are all
--   unchanged. Only edition_count, editions_with_fmv and fmv_coverage_pct move.
--   No pricing logic is touched.
--
-- NOT CHANGED, DELIBERATELY (verified, not overlooked)
--   * public.compute_pack_ev_from_pool -- also lacks a weight filter, but its EV is an
--     equal-weight trimmed mean over ALL pool rows, so filtering the coverage counts
--     alone would make coverage describe a different set than the EV beside it, and
--     filtering the mean would be a repricing. Its only live callers are the AllDay
--     edge fn (compute-allday-pack-ev) and the Golazos cron (compute-laliga-pack-ev),
--     and BOTH collections have zero exhausted rows, so there is nothing to dilute.
--   * public.compute_pack_ev_from_pool_tier_weighted -- zero callers in the database,
--     zero callers in the repo, zero pg_cron entries. Dead; left untouched.
--
-- REVERT SQL (restores the previous definition verbatim)
--   See supabase/migrations/20260731210000_audit_20260731_snapshot_stale_pin_ddl_fmv_clamp_and_pack_ev.sql
--   and re-apply the compute_pack_ev_per_edition_weighted block from that file.
--   The change is a pure CREATE OR REPLACE; no data is written and no unwind is needed.
CREATE OR REPLACE FUNCTION public.compute_pack_ev_per_edition_weighted(p_collection_id uuid, p_dist_id text, p_pack_price numeric, p_slots integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pool_rows_total         int;
  v_edition_count           int;
  v_editions_with_fmv       int;
  v_per_slot_ev             numeric;
  v_typical_per_slot        numeric;
  v_total_weight            numeric;
  v_covered_weight          numeric;
  v_weighted_coverage_pct   smallint;
  v_unweighted_coverage_pct smallint;
  v_gross_ev                numeric;
  v_typical_pull_ev         numeric;
  v_pack_ev                 numeric;
  v_value_ratio             numeric;
  v_use_original            boolean;
  v_basis                   text;
  v_live_rows               int;
  v_live_distinct_weights   int;
  v_is_topshot              boolean;
  v_sum_dw                  numeric;
BEGIN
  v_is_topshot := (p_collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid);

  IF v_is_topshot THEN
    SELECT count(*), count(DISTINCT drop_weight), COALESCE(sum(drop_weight),0)
      INTO v_live_rows, v_live_distinct_weights, v_sum_dw
    FROM pack_drop_pool
    WHERE collection_id = p_collection_id AND dist_id = p_dist_id AND drop_weight > 0;
    IF v_live_rows = 0 OR (v_live_rows > 1 AND v_live_distinct_weights <= 1) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'no_varied_remaining_pool', 'dist_id', p_dist_id);
    END IF;
    IF v_sum_dw < 0.5 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'pool_incomplete', 'dist_id', p_dist_id,
                                'sum_drop_weight', round(v_sum_dw, 4));
    END IF;
  END IF;

  IF v_is_topshot THEN
    v_use_original := false;
  ELSE
    SELECT bool_or(orig_drop_weight IS NOT NULL) INTO v_use_original
    FROM pack_drop_pool
    WHERE collection_id = p_collection_id AND dist_id = p_dist_id;
    v_use_original := COALESCE(v_use_original, false);
  END IF;
  v_basis := CASE WHEN v_use_original THEN 'original' ELSE 'remaining' END;

  -- v_edition_count counts only PULLABLE editions (weight > 0 under the basis actually
  -- in use). It is the denominator of fmv_coverage_pct, so counting editions that have
  -- been exhausted to zero weight published a coverage figure diluted by editions that
  -- can no longer come out of the pack. v_pool_rows_total keeps the original unfiltered
  -- count so the pool_empty guard behaves exactly as before.
  -- EV-NEUTRAL BY CONSTRUCTION: a zero-weight row contributes 0 to both the numerator
  -- and the denominator of every weighted aggregate below, so gross_ev, typical_pull_ev,
  -- pack_ev, value_ratio, total_pool_weight, covered_pool_weight and
  -- weighted_fmv_coverage_pct are all unchanged. Only the COUNT-based fields move.
  SELECT count(*),
         count(*) FILTER (WHERE (CASE WHEN v_use_original THEN COALESCE(orig_drop_weight, 0) ELSE drop_weight END) > 0),
         COALESCE(sum(CASE WHEN v_use_original THEN COALESCE(orig_drop_weight, 0) ELSE drop_weight END), 0)
    INTO v_pool_rows_total, v_edition_count, v_total_weight
  FROM pack_drop_pool pdp
  WHERE pdp.collection_id = p_collection_id AND pdp.dist_id = p_dist_id;

  IF v_pool_rows_total = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pool_empty', 'dist_id', p_dist_id);
  END IF;
  IF v_total_weight = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'zero_total_weight', 'dist_id', p_dist_id);
  END IF;

  -- Mean + coverage over covered pool; weighted MEDIAN moment value for the typical pull.
  WITH pool AS (
    SELECT
      CASE WHEN v_use_original THEN COALESCE(pdp.orig_drop_weight, 0) ELSE pdp.drop_weight END AS w,
      fc.fmv_usd
    FROM pack_drop_pool pdp
    LEFT JOIN fmv_current fc
      ON fc.edition_id = pdp.edition_id
      AND fc.collection_id = pdp.collection_id
    WHERE pdp.collection_id = p_collection_id
      AND pdp.dist_id = p_dist_id
  ),
  agg AS (
    SELECT
      sum(w * fmv_usd) FILTER (WHERE fmv_usd IS NOT NULL)
        / NULLIF(sum(w) FILTER (WHERE fmv_usd IS NOT NULL), 0) AS mean_ev,
      count(*) FILTER (WHERE fmv_usd IS NOT NULL AND w > 0) AS n_fmv,
      sum(w) FILTER (WHERE fmv_usd IS NOT NULL) AS cov_w
    FROM pool
  ),
  cum AS (
    SELECT fmv_usd,
           sum(w) OVER (ORDER BY fmv_usd) AS cw,
           sum(w) OVER () AS tw
    FROM pool WHERE fmv_usd IS NOT NULL AND w > 0
  ),
  med AS (
    SELECT min(fmv_usd) AS median_ev FROM cum WHERE cw >= 0.5 * tw
  )
  SELECT agg.mean_ev, agg.n_fmv, agg.cov_w, med.median_ev
  INTO v_per_slot_ev, v_editions_with_fmv, v_covered_weight, v_typical_per_slot
  FROM agg CROSS JOIN med;

  IF v_editions_with_fmv = 0 OR v_per_slot_ev IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_fmv_coverage', 'dist_id', p_dist_id);
  END IF;

  v_weighted_coverage_pct   := (100.0 * v_covered_weight / v_total_weight)::smallint;
  v_unweighted_coverage_pct := (100.0 * v_editions_with_fmv / v_edition_count)::smallint;

  v_gross_ev := round((v_per_slot_ev * GREATEST(p_slots, 1))::numeric, 2);
  v_typical_pull_ev := round((COALESCE(v_typical_per_slot, 0) * GREATEST(p_slots, 1))::numeric, 2);
  v_pack_ev  := round((v_gross_ev - COALESCE(p_pack_price, 0))::numeric, 2);
  v_value_ratio := CASE WHEN p_pack_price > 0
    THEN round((v_gross_ev / p_pack_price)::numeric, 3)
    ELSE NULL END;

  v_pack_ev  := GREATEST(LEAST(v_pack_ev, 1000000), -10000);
  v_gross_ev := GREATEST(LEAST(v_gross_ev, 1000000), -10000);
  v_typical_pull_ev := GREATEST(LEAST(v_typical_pull_ev, 1000000), 0);

  RETURN jsonb_build_object(
    'ok', true,
    'gross_ev', v_gross_ev,
    'typical_pull_ev', v_typical_pull_ev,
    'typical_per_slot', round(COALESCE(v_typical_per_slot,0),2),
    'pack_ev', v_pack_ev,
    'value_ratio', v_value_ratio,
    'is_positive_ev', v_pack_ev > 0,
    'edition_count', v_edition_count,
    'pool_rows_total', v_pool_rows_total,
    'editions_with_fmv', v_editions_with_fmv,
    'fmv_coverage_pct', v_unweighted_coverage_pct,
    'weighted_fmv_coverage_pct', v_weighted_coverage_pct,
    'per_edition_weighted', true,
    'ev_basis', v_basis,
    'total_pool_weight', round(v_total_weight, 4),
    'covered_pool_weight', round(v_covered_weight, 4)
  );
END;
$function$;
