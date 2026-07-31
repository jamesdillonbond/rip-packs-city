-- audit_20260731_snapshot_stale_pin_ddl_fmv_clamp_and_pack_ev
--
-- DOCUMENTATION SNAPSHOT — NOT a behavior change.
--
-- Found while auditing the DB-invariant pins after promote_unmapped_sales was
-- caught pinned to a superseded migration (2026-07-31). Two more pins were
-- validating definitions production had moved past, and NEITHER was detectable
-- from the repo alone: in both cases the repo carries exactly ONE migration
-- defining the function, so a "does the pin name the newest committed migration
-- defining this function?" check returns green. The later definitions were
-- applied via MCP and never committed as files, so the drift lives only between
-- the repo and the live DB.
--
--   fmv_clamp_disconnected_ask_topshot
--     pinned copy: 20260702140000_audit_20260702_fmv_clamp_disconnected_ask_topshot.sql
--                  (= schema_migrations version 20260702144533)
--     live since:  schema_migrations version 20260702165429 — ~2h later the SAME
--                  DAY, so this pin has been stale since the day it was written.
--     what changed: the CLAMP SELECTION PREDICATE, i.e. the whole point of the
--                  function. Pinned copy selects a circulation-gated
--                      (circulation_count >= 1000 AND fmv > p90*3) OR fmv > p90*8
--                  Live selects a circulation-agnostic
--                      fmv > med*3 AND fmv > p90*1.5
--                  These pick different edition sets — an edition at 5x median
--                  with circulation 100 is untouched under the pinned rule and
--                  clamped under the live one. Live also wraps the pipeline_runs
--                  INSERT in `IF v_clamped > 0`, so a no-op run logs nothing.
--
--   compute_pack_ev_per_edition_weighted
--     pinned copy: 20260707142744_audit_20260707_compute_pack_ev_require_varied_remaining_pool_ts.sql
--     live since:  schema_migrations version 20260717193153 (4 intervening
--                  redefinitions, none committed) — the pin ran ~2 weeks stale.
--     what changed: the live function computes the weighted-MEDIAN moment value
--                  and returns `typical_pull_ev` / `typical_per_slot` alongside
--                  the mean-based `gross_ev`, and adds a `pool_incomplete` guard
--                  (Top Shot, sum(drop_weight) < 0.5). The pinned copy has none
--                  of it — so the number the public pack-EV surfaces LEAD with
--                  (Typical Pull, not Actual EV) had no pinned invariant at all.
--
-- Each block below is a VERBATIM copy of the live definition captured via
-- pg_get_functiondef() on 2026-07-31 (project bxcqstmqfzmuolpuynti). Re-applying
-- is an idempotent CREATE OR REPLACE with a byte-identical body — a pure no-op
-- against prod. It exists so supabase/tests/*.sql can pin the definitions that
-- are ACTUALLY RUNNING, with __tests__/db-invariants-drift-guard.test.ts keeping
-- the pinned copies honest.
--
-- REVERT: this migration changes no behavior; reverting the commit is enough.
-- Re-applying the superseded definitions would be a real regression — do not.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1/2  fmv_clamp_disconnected_ask_topshot
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fmv_clamp_disconnected_ask_topshot(p_dry_run boolean DEFAULT false)
 RETURNS TABLE(rows_examined bigint, rows_clamped bigint, dollars_removed numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  c_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_started timestamptz := clock_timestamp();
  v_examined bigint := 0;
  v_clamped  bigint := 0;
  v_dollars  numeric := 0;
BEGIN
  IF p_dry_run THEN
    WITH latest AS (
      SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.fmv_usd, fs.confidence
      FROM public.fmv_snapshots fs
      WHERE fs.collection_id = c_ts
      ORDER BY fs.edition_id, fs.computed_at DESC
    ),
    s90 AS (
      SELECT s.edition_id,
        count(*) FILTER (WHERE s.price_usd > 0.10) AS n_real,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS p90,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS med
      FROM public.sales s
      WHERE s.collection_id = c_ts AND s.sold_at >= now() - interval '90 days'
      GROUP BY s.edition_id
    ),
    targets AS (
      SELECT l.id AS snapshot_id, l.fmv_usd AS old_fmv,
             ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2) AS new_fmv
      FROM latest l
      JOIN s90 s ON s.edition_id = l.edition_id
      JOIN public.editions e ON e.id = l.edition_id
      WHERE l.confidence IN ('LOW','ASK_ONLY')
        AND s.n_real >= 5 AND s.p90 > 0
        AND l.fmv_usd > s.med * 3
        AND l.fmv_usd > s.p90 * 1.5
        AND l.fmv_usd > ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2)
    )
    SELECT count(*), COALESCE(sum(old_fmv - new_fmv), 0) INTO v_examined, v_dollars FROM targets;
    v_clamped := v_examined;
  ELSE
    WITH latest AS (
      SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.fmv_usd, fs.confidence
      FROM public.fmv_snapshots fs
      WHERE fs.collection_id = c_ts
      ORDER BY fs.edition_id, fs.computed_at DESC
    ),
    s90 AS (
      SELECT s.edition_id,
        count(*) FILTER (WHERE s.price_usd > 0.10) AS n_real,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS p90,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd) FILTER (WHERE s.price_usd > 0.10) AS med
      FROM public.sales s
      WHERE s.collection_id = c_ts AND s.sold_at >= now() - interval '90 days'
      GROUP BY s.edition_id
    ),
    targets AS (
      SELECT l.id AS snapshot_id, l.fmv_usd AS old_fmv,
             ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2) AS new_fmv
      FROM latest l
      JOIN s90 s ON s.edition_id = l.edition_id
      JOIN public.editions e ON e.id = l.edition_id
      WHERE l.confidence IN ('LOW','ASK_ONLY')
        AND s.n_real >= 5 AND s.p90 > 0
        AND l.fmv_usd > s.med * 3
        AND l.fmv_usd > s.p90 * 1.5
        AND l.fmv_usd > ROUND(GREATEST(s.p90 * 1.5, s.med)::numeric, 2)
    ),
    upd AS (
      UPDATE public.fmv_snapshots fs
      SET fmv_usd = t.new_fmv,
          algo_version = CASE WHEN RIGHT(COALESCE(fs.algo_version,''),9) = '_p90clamp'
                              THEN fs.algo_version
                              ELSE COALESCE(fs.algo_version,'') || '_p90clamp' END
      FROM targets t
      WHERE fs.id = t.snapshot_id
      RETURNING (t.old_fmv - t.new_fmv) AS delta
    )
    SELECT count(*), COALESCE(sum(delta), 0) INTO v_clamped, v_dollars FROM upd;
    v_examined := v_clamped;

    IF v_clamped > 0 THEN
      INSERT INTO public.pipeline_runs (pipeline, started_at, finished_at, ok, extra)
      VALUES ('fmv-clamp-disconnected-ask', v_started, clock_timestamp(), true,
              jsonb_build_object('rows_clamped', v_clamped, 'dollars_removed', round(v_dollars, 2)));
    END IF;
  END IF;

  RETURN QUERY SELECT v_examined, v_clamped, round(v_dollars, 2);
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2/2  compute_pack_ev_per_edition_weighted
-- ─────────────────────────────────────────────────────────────────────────────
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
      count(*) FILTER (WHERE fmv_usd IS NOT NULL) AS n_fmv,
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
