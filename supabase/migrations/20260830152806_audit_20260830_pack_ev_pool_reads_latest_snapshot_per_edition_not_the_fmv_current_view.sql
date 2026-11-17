-- audit_20260830: compute_pack_ev_per_edition_weighted priced a 40-80 row pool
-- by walking every fmv_snapshots row -- the DISTINCT ON view class from #52.
--
-- MEASURED 2026-08-30 15:2xZ. jobid 71 `rpc-backfill-historical-pack-ev`
-- (cron_heavy, `13 * * * *`, backfill_topshot_historical_pack_ev(15)): 24 runs
-- / 24 h at 245 s mean, 5 timeouts; ONE call in the 15:04->15:20Z pgss diff:
-- 190 s and 133,872,648 buffer hits -- ~9M per priced pack. PostgREST callers
-- (compute-allday-pack-ev, rpc_thp_leg_pack_ev): 32 calls / 48 s / 636k hits
-- each in the same window. The cost is one line: the pool CTE
-- `LEFT JOIN fmv_current fc ON fc.edition_id = pdp.edition_id AND
-- fc.collection_id = pdp.collection_id`. fmv_current is `SELECT DISTINCT ON
-- (edition_id) ... FROM fmv_snapshots ORDER BY edition_id, computed_at DESC`,
-- and the planner cannot push the pool's edition_ids into a DISTINCT ON, so
-- it materialises the view: Merge Append over 1,312,068 snapshot rows for
-- dist 1246's 80 pool rows -- 1,259,494 buffers, 17.2 s. The same 80 rows via
-- one LATERAL `ORDER BY computed_at DESC LIMIT 1` per pool edition: 530
-- buffers, 5.9 ms. Output diffed with EXCEPT both ways over dists 1246 and
-- 1239 (152 rows): 0 / 0.
--
-- CHANGE: that one join. Semantics preserved exactly: the view's row is the
-- edition's newest snapshot regardless of collection (fmv_usd may be NULL),
-- and the join's collection predicate then decides whether the pool row is
-- priced; the LATERAL does the same two steps. Every guard, aggregate, the
-- weighted median, the basis rule and the jsonb shape are untouched.
--
-- Pinned: supabase/tests/compute_pack_ev_per_edition_weighted.sql -- the
-- fixture's stand-in `fmv_current` table is replaced by an `fmv_snapshots`
-- table (the function now reads that), OTHER gets its own editions (a real
-- edition belongs to one collection; the old fixture priced eA/eB in two),
-- and two new cases pin the two steps: an older snapshot never wins over a
-- newer one, and a pool row whose edition's newest snapshot belongs to
-- another collection is unpriced. __tests__/db-invariants-drift-guard.test.ts
-- re-pointed.
--
-- anon-exec: compute_pack_ev_per_edition_weighted -- unchanged (STABLE, not
-- SECURITY DEFINER; CREATE OR REPLACE keeps the existing grants).
--
-- Exit (24 h): jobid 71 mean falls from 245 s toward tens of seconds with 0
-- timeouts; compute_pack_ev_per_edition_weighted per-call hits fall from
-- ~636k toward ~1k. Falsifier: jobid 71 unchanged -> the cost is in
-- backfill_topshot_historical_pack_ev's own candidate scan, not here.
-- Revert: re-apply the body from 20260802210000_audit_20260802_pack_ev_coverage_denominator_pullable_only.sql.

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
    -- 2026-08-30: the latest snapshot per pool edition, looked up per row.
    -- This was `LEFT JOIN fmv_current` -- the DISTINCT ON view -- and the
    -- planner cannot push a join key into DISTINCT ON, so every call walked
    -- all 1.31M fmv_snapshots rows to price a 40-80 row pool: 1,259,494
    -- buffers / 17.2 s vs 530 buffers / 6 ms for the identical rows (dist
    -- 1246). Same semantics as the view: newest snapshot for the edition
    -- regardless of collection, then the collection must match or the row
    -- is unpriced.
    LEFT JOIN LATERAL (
      SELECT s.fmv_usd, s.collection_id
      FROM fmv_snapshots s
      WHERE s.edition_id = pdp.edition_id
      ORDER BY s.computed_at DESC
      LIMIT 1
    ) fc ON fc.collection_id = pdp.collection_id
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
