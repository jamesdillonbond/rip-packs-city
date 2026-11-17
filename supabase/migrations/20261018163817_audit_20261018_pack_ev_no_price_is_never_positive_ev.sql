-- compute_pack_ev_per_edition_weighted: a pack with no price is never marked +EV.
--
-- WHY (2026-10-18 ~9:40 AM PT, Claude Code cloud; pack-ev.md Now 2, the COALESCE(…,0) audit's write side):
-- compute-allday-pack-ev and compute-golazos-pack-ev pass `p_pack_price = 0` when Dapper's node.price is
-- absent. pack_ev = gross_ev − COALESCE(price, 0) = gross_ev, so 'is_positive_ev' (pack_ev > 0) was TRUE
-- for every unpriced pack: 2,360 All Day + 176 Golazos latest pack_ev_history rows on 10-18, and 27 more on
-- the 9:37 AM PT All Day tick. Readers neutralised it (pack_ev_latest, pack_table_rows, the 1..5000 price
-- band), so no surface showed a false "+EV", but the stored fact was wrong and one new reader away from
-- publishing. (The shared TS weightedMeanEv got the same fix earlier the same morning; Pinnacle uses that
-- path, All Day and Golazos use this RPC — the first fix missed them, caught by the lane's own next tick.)
-- WHAT: 'is_positive_ev' := COALESCE(p_pack_price, 0) > 0 AND v_pack_ev > 0 — false, never NULL, because the
-- writers coerce it into pack_ev_history.is_positive_ev (NOT NULL). Nothing else in the body changes; pin
-- md5 == live was proven before the edit, and the pin gains the price-0 / NULL assertions.
-- anon-exec: unchanged (compute_pack_ev_per_edition_weighted) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified anon=true, authenticated=true (a read-only pricing helper; not SECURITY DEFINER).
--
-- REVERT: re-run this block with 'is_positive_ev', v_pack_ev > 0,

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
    'is_positive_ev', COALESCE(p_pack_price, 0) > 0 AND v_pack_ev > 0,
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
