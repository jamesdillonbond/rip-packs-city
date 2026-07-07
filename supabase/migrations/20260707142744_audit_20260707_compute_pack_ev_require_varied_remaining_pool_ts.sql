-- Single-point honesty guard in the canonical pack-EV math. For Top Shot, require a
-- REAL VARIED remaining pool (count(distinct drop_weight) > 1 among drop_weight>0) before
-- returning an EV; a uniform/zero remaining pool is the packEditionsV3 placeholder for
-- depleted packs, with no honest "remaining moments" to price -> ok:false. Stops the
-- uniform-degenerate fabrication class from EVERY writer at once (backfill jobid 43 AND
-- the active compute-topshot-pack-ev edge fn, which both call this fn; the edge fn emits
-- a sentinel on ok:false). Scoped to TS so AllDay/Pinnacle/Golazos are untouched.
-- NOTE: does NOT catch varied-but-chase-only survivor bias (e.g. dist 6033) -- that needs
-- an EV-vs-secondary-ask output guard at the caller (jobid 43 has it; the edge fn does
-- not yet). Fix B still suppresses those on display. Per Trevor 2026-07-07.
-- Applied live via MCP (20260707142744). Revert: drop the added TS IF block.
CREATE OR REPLACE FUNCTION public.compute_pack_ev_per_edition_weighted(p_collection_id uuid, p_dist_id text, p_pack_price numeric, p_slots integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_edition_count           int;
  v_editions_with_fmv       int;
  v_per_slot_ev             numeric;
  v_total_weight            numeric;
  v_covered_weight          numeric;
  v_weighted_coverage_pct   smallint;
  v_unweighted_coverage_pct smallint;
  v_gross_ev                numeric;
  v_pack_ev                 numeric;
  v_value_ratio             numeric;
  v_use_original            boolean;
  v_basis                   text;
BEGIN
  IF p_collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
     AND (SELECT count(DISTINCT drop_weight) FROM pack_drop_pool
          WHERE collection_id = p_collection_id AND dist_id = p_dist_id AND drop_weight > 0) <= 1 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_varied_remaining_pool', 'dist_id', p_dist_id);
  END IF;

  SELECT bool_or(orig_drop_weight IS NOT NULL) INTO v_use_original
  FROM pack_drop_pool
  WHERE collection_id = p_collection_id AND dist_id = p_dist_id;
  v_use_original := COALESCE(v_use_original, false);
  v_basis := CASE WHEN v_use_original THEN 'original' ELSE 'remaining' END;

  SELECT count(*),
         COALESCE(sum(CASE WHEN v_use_original THEN COALESCE(orig_drop_weight, 0) ELSE drop_weight END), 0)
    INTO v_edition_count, v_total_weight
  FROM pack_drop_pool pdp
  WHERE pdp.collection_id = p_collection_id AND pdp.dist_id = p_dist_id;

  IF v_edition_count = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pool_empty', 'dist_id', p_dist_id);
  END IF;
  IF v_total_weight = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'zero_total_weight', 'dist_id', p_dist_id);
  END IF;

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
  )
  SELECT
    sum(w * fmv_usd) FILTER (WHERE fmv_usd IS NOT NULL)
      / NULLIF(sum(w) FILTER (WHERE fmv_usd IS NOT NULL), 0),
    count(*) FILTER (WHERE fmv_usd IS NOT NULL),
    sum(w) FILTER (WHERE fmv_usd IS NOT NULL)
  INTO v_per_slot_ev, v_editions_with_fmv, v_covered_weight
  FROM pool;

  IF v_editions_with_fmv = 0 OR v_per_slot_ev IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_fmv_coverage', 'dist_id', p_dist_id);
  END IF;

  v_weighted_coverage_pct   := (100.0 * v_covered_weight / v_total_weight)::smallint;
  v_unweighted_coverage_pct := (100.0 * v_editions_with_fmv / v_edition_count)::smallint;

  v_gross_ev := round((v_per_slot_ev * GREATEST(p_slots, 1))::numeric, 2);
  v_pack_ev  := round((v_gross_ev - COALESCE(p_pack_price, 0))::numeric, 2);
  v_value_ratio := CASE WHEN p_pack_price > 0
    THEN round((v_gross_ev / p_pack_price)::numeric, 3)
    ELSE NULL END;

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
    'fmv_coverage_pct', v_unweighted_coverage_pct,
    'weighted_fmv_coverage_pct', v_weighted_coverage_pct,
    'per_edition_weighted', true,
    'ev_basis', v_basis,
    'total_pool_weight', round(v_total_weight, 4),
    'covered_pool_weight', round(v_covered_weight, 4)
  );
END;
$function$;
