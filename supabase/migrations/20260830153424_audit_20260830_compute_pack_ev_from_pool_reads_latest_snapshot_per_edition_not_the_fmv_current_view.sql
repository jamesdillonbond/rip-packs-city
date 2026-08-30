-- audit_20260830: compute_pack_ev_from_pool walked every fmv_snapshots row
-- TWICE per call (coverage count + mean) -- the fmv_current view class, third
-- instance today after 20260830152806 and 20260830153041.
--
-- MEASURED 2026-08-30 15:4xZ: pg_stat_statements lifetime 375 PostgREST calls,
-- 3,310 ms mean (most are Golazos calls from /api/cron/compute-laliga-pack-ev
-- that return pool_empty at the first count -- Golazos has no pack_drop_pool
-- rows -- which hides the cost of the ones that price). EXPLAIN ANALYZE of one
-- priced call (All Day, the largest pool): 2,578,477 buffer hits + 29,993
-- reads, 21.9 s. Cause: three `JOIN fmv_current fc ON fc.edition_id =
-- pdp.edition_id AND fc.collection_id = pdp.collection_id` -- the coverage
-- count, the trimmed mean (pool > 20) and the raw mean -- each a full
-- DISTINCT ON materialisation of 1.31M snapshot rows.
--
-- CHANGE: each becomes a per-edition LATERAL (newest snapshot regardless of
-- collection, then the collection must match) with the same
-- `fc.fmv_usd IS NOT NULL` predicate kept in WHERE. Trim rule, clamps and the
-- jsonb shape untouched. Not pinned (2026-05-12 DDL, no pin); previous joins
-- quoted in the REVERT note.
--
-- anon-exec: compute_pack_ev_from_pool -- unchanged (STABLE, not SECURITY
-- DEFINER; CREATE OR REPLACE keeps the existing grants).
--
-- Exit (24 h): the function's mean falls from 3.3 s toward tens of ms and
-- hits/call from millions toward ~2k on priced calls. Falsifier: unchanged ->
-- the callers' cost is elsewhere (the Golazos route's own loop).
-- REVERT: replace each `JOIN LATERAL (...) fc ON fc.collection_id = pdp.collection_id`
-- with `JOIN fmv_current fc ON fc.edition_id = pdp.edition_id AND fc.collection_id = pdp.collection_id`.

CREATE OR REPLACE FUNCTION public.compute_pack_ev_from_pool(p_collection_id uuid, p_dist_id text, p_pack_price numeric, p_slots integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_edition_count      int;
  v_editions_with_fmv  int;
  v_trim_count         int := 0;
  v_trim_applied       boolean := false;
  v_mean_fmv           numeric;
  v_gross_ev           numeric;
  v_pack_ev            numeric;
  v_value_ratio        numeric;
  v_fmv_coverage_pct   smallint;
BEGIN
  -- Full pool size (for coverage stats)
  SELECT count(*) INTO v_edition_count
  FROM pack_drop_pool pdp
  WHERE pdp.collection_id = p_collection_id AND pdp.dist_id = p_dist_id;

  IF v_edition_count = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pool_empty', 'dist_id', p_dist_id);
  END IF;

  -- Count FMV coverage
  -- 2026-08-30: per-edition LATERAL instead of the fmv_current view (a full
  -- 1.31M-row pass per join). Same semantics: newest snapshot for the
  -- edition regardless of collection, then the collection must match.
  SELECT count(*) INTO v_editions_with_fmv
  FROM pack_drop_pool pdp
  JOIN LATERAL (
    SELECT s.fmv_usd, s.collection_id
    FROM fmv_snapshots s
    WHERE s.edition_id = pdp.edition_id
    ORDER BY s.computed_at DESC
    LIMIT 1
  ) fc ON fc.collection_id = pdp.collection_id
  WHERE pdp.collection_id = p_collection_id
    AND pdp.dist_id = p_dist_id
    AND fc.fmv_usd IS NOT NULL;

  IF v_editions_with_fmv = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_fmv_coverage', 'dist_id', p_dist_id);
  END IF;

  -- Compute trimmed mean if pool > 20, else raw mean.
  -- Top-10% trim (at least 1 row) curbs ultra-rare outlier domination
  -- under the equal-weight assumption when tier probabilities are unknown.
  IF v_editions_with_fmv > 20 THEN
    v_trim_count := GREATEST(1, (v_editions_with_fmv * 0.10)::int);
    v_trim_applied := true;

    WITH pool_fmvs AS (
      SELECT fc.fmv_usd AS fmv,
             row_number() OVER (ORDER BY fc.fmv_usd DESC) AS rn
      FROM pack_drop_pool pdp
      JOIN LATERAL (
        SELECT s.fmv_usd, s.collection_id
        FROM fmv_snapshots s
        WHERE s.edition_id = pdp.edition_id
        ORDER BY s.computed_at DESC
        LIMIT 1
      ) fc ON fc.collection_id = pdp.collection_id
      WHERE pdp.collection_id = p_collection_id
        AND pdp.dist_id = p_dist_id
        AND fc.fmv_usd IS NOT NULL
    )
    SELECT avg(fmv) INTO v_mean_fmv
    FROM pool_fmvs
    WHERE rn > v_trim_count;
  ELSE
    SELECT avg(fc.fmv_usd) INTO v_mean_fmv
    FROM pack_drop_pool pdp
    JOIN LATERAL (
      SELECT s.fmv_usd, s.collection_id
      FROM fmv_snapshots s
      WHERE s.edition_id = pdp.edition_id
      ORDER BY s.computed_at DESC
      LIMIT 1
    ) fc ON fc.collection_id = pdp.collection_id
    WHERE pdp.collection_id = p_collection_id
      AND pdp.dist_id = p_dist_id
      AND fc.fmv_usd IS NOT NULL;
  END IF;

  v_gross_ev := round((v_mean_fmv * GREATEST(p_slots, 1))::numeric, 2);
  v_pack_ev  := round((v_gross_ev - COALESCE(p_pack_price, 0))::numeric, 2);
  v_value_ratio := CASE WHEN p_pack_price > 0 
    THEN round((v_gross_ev / p_pack_price)::numeric, 3) 
    ELSE NULL END;
  v_fmv_coverage_pct := (100.0 * v_editions_with_fmv / v_edition_count)::smallint;

  -- Clamp to pack_ev_history CHECK range
  v_pack_ev  := GREATEST(LEAST(v_pack_ev, 1000000), -10000);
  v_gross_ev := GREATEST(LEAST(v_gross_ev, 1000000), -10000);

  RETURN jsonb_build_object(
    'ok', true,
    'gross_ev', v_gross_ev,
    'pack_ev', v_pack_ev,
    'value_ratio', v_value_ratio,
    'is_positive_ev', v_pack_ev > 0,
    'edition_count', v_edition_count,
    'editions_with_fmv', v_editions_with_fmv,
    'fmv_coverage_pct', v_fmv_coverage_pct,
    'trim_applied', v_trim_applied,
    'trim_count', v_trim_count
  );
END;
$function$;
