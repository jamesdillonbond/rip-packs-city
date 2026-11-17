-- audit_20260831_thin_sales_guard_lateral_latest_instead_of_distinct_on_the_whole_history
--
-- WHY: apply_fmv_thin_sales_guard(p_mode) was the #1 REAL read consumer on the pg_stat_statements
-- DIFF over 2026-08-31 13:25:13Z -> 15:02:50Z (the only larger row is public.query_sql, the generic
-- SQL passthrough, whose per-call mean is meaningless because every caller collapses into it):
-- 10 calls, 13,034,115 shared blocks, 1,303,411 blocks/call, 18,205 ms. Its driving cursor is a
-- `DISTINCT ON (edition_id) ... FROM fmv_snapshots ORDER BY edition_id, computed_at DESC` over the
-- WHOLE partitioned history -- 1,353,022 rows / 710 MB -- and then throws 26,364 of the 27,160
-- resulting rows away on `fmv_usd > 200 AND confidence <> 'ASK_ONLY'`, keeping 796.
-- Measured 2026-08-31 15:0xZ, EXPLAIN (ANALYZE, BUFFERS), baseline re-run AFTER the candidate so both
-- readings are in the same state:
--     baseline  1,300,717 / 1,300,773 buffers, 2,034 / 1,939 ms, 796 rows
--     candidate   168,886            buffers,     383       ms, 796 rows
-- = 7.7x fewer buffers touched, 5.1x faster. This is a PLAN change (Merge Append over 1.35 M rows ->
-- 27,331 index probes on fmv_snapshots_*_edition_id_computed_at_idx), so it cannot be a warm-cache
-- artifact. Same class as 20260830165128 (get_market_summary) and the 08-30 pack-EV wave.
-- (i) The guard currently applies ZERO caps per call (dry_run 15:06:47Z: total_examined 796,
-- skipped_already_capped 616, thin/stale/common all 0) -- so this was 1.3 M buffers to decide nothing.
--
-- WHAT: drive the cursor from `editions` with a LATERAL "newest snapshot for this edition" instead of
-- materialising the newest row for EVERY edition first. EQUIVALENCE PROVEN, not asserted: both shapes
-- run side by side at 15:05Z returned 796 rows and the symmetric difference over all 26 output columns
-- was 0 in both directions (`base EXCEPT cand` = 0, `cand EXCEPT base` = 0). Driving from `editions`
-- loses nothing: `SELECT count(*) FROM fmv_snapshots f WHERE NOT EXISTS (SELECT 1 FROM editions e
-- WHERE e.id = f.edition_id)` = 0, and the original's `JOIN editions` was already an inner join.
-- NOT driven from edition_fmv_current, even though it is the same 27,160 edition_ids and is what
-- 20260830165128 used: it lags fmv_snapshots by its refresh watermark, and 70 of 27,160 rows had a
-- DIFFERENT (fmv_usd, confidence) at 15:04Z -- enough to move editions in and out of a `> 200` filter.
-- The LATERAL reads the live newest row, so there is no lag and no population drift.
--
-- Nothing else in the function body changes: same cap branches, same INSERTs, same return object,
-- same signature, same SECURITY DEFINER / VOLATILE / search_path. ACL (postgres + service_role only,
-- no anon, no authenticated) is preserved by CREATE OR REPLACE and re-asserted below.
-- (!) `p_mode text DEFAULT 'dry_run'::text` is LOAD-BEARING and is restated verbatim: a bare
-- `SELECT apply_fmv_thin_sales_guard()` must stay a dry run. Postgres refused the first attempt at
-- this migration ("cannot remove parameter defaults from existing function") because the default was
-- omitted -- that refusal is the safety net, not a nuisance.
-- (!) The guards below anchor on `SELECT l.*, e.tier` / `CROSS JOIN LATERAL`, NOT on `WITH latest AS`
-- or `DISTINCT ON`. Second attempt at this migration aborted on its own post-condition because the
-- explanatory COMMENT inside the new body quotes the old cursor, and prosrc contains comments: an
-- anchor that also matches the text describing the change is not an anchor. Both strings chosen here
-- appear in exactly one of the two bodies and in neither comment.
-- anon-exec: apply_fmv_thin_sales_guard (no anon/authenticated EXECUTE before or after; ACL re-asserted)
--
-- EXIT / FALSIFIER (derived from the post-fix measurement above, not from a hoped-for round number):
--   PASS if, on the next pgss diff that contains this function, blocks/call is under 400,000
--   (candidate measured 168,886 for the cursor; the loop body adds ~3,000) AND a dry_run still
--   reports total_examined = 796 +/- normal drift with the same skipped/applied split.
--   FAIL (revert) if blocks/call stays above 1,000,000, or total_examined changes by more than the
--   number of editions whose latest snapshot legitimately crossed the 200 / ASK_ONLY boundary.
--
-- REVERT: re-apply the prior body -- `WITH latest AS (SELECT DISTINCT ON (edition_id) ... FROM
-- fmv_snapshots fs ORDER BY edition_id, computed_at DESC) SELECT l.*, e.tier, e.set_name,
-- e.external_id, c.slug FROM latest l JOIN editions e ON e.id = l.edition_id JOIN collections c
-- ON c.id = l.collection_id WHERE l.fmv_usd > 200 AND l.confidence::text <> 'ASK_ONLY'` -- keeping
-- every other line of this file. The prior body is in git history at this migration's parent.

-- Guard: refuse to run if the body we measured is not the body that is live (a concurrent session
-- may have changed it). RAISEs rather than silently replacing something else.
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'apply_fmv_thin_sales_guard'
      AND p.prosrc LIKE '%SELECT l.*, e.tier%'
      AND p.prosrc NOT LIKE '%CROSS JOIN LATERAL%'
      AND p.prosrc LIKE '%thin-sales-guard-v3%'
  ) THEN
    RAISE EXCEPTION 'apply_fmv_thin_sales_guard does not carry the DISTINCT ON cursor this migration was measured against - re-measure before replacing it';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.apply_fmv_thin_sales_guard(p_mode text DEFAULT 'dry_run'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_thin_sales_count INT := 0;
  v_stale_count INT := 0;
  v_common_outlier_count INT := 0;
  v_skipped_already_capped INT := 0;
  v_total_examined INT := 0;
  rec RECORD;
  v_cap NUMERIC;
  v_reason TEXT;
  v_new_confidence TEXT;
  v_can_use_ask BOOLEAN;
  v_fresh_ask NUMERIC;
BEGIN
  IF p_mode NOT IN ('dry_run','live') THEN
    RAISE EXCEPTION 'p_mode must be dry_run or live, got %', p_mode;
  END IF;

  -- 2026-08-31: the cursor used to materialise the newest snapshot for EVERY edition first (a full
  -- 1.35 M-row pass over the whole partitioned history) and then keep 796 rows. Driving from editions
  -- with a LATERAL newest-snapshot lookup returns the same 796 rows (symmetric difference 0 over all
  -- 26 columns, verified live) for 168,886 buffers instead of 1,300,773.
  FOR rec IN
    SELECT
      fs.edition_id, fs.collection_id, fs.fmv_usd, fs.asp_usd AS wap_usd,
      fs.asp_without_outliers AS wap_without_outliers, fs.ask_proxy_fmv,
      fs.top_shot_ask, fs.flowty_ask, fs.cross_market_ask,
      fs.sales_count_7d, fs.sales_count_30d, fs.confidence,
      fs.algo_version, fs.computed_at, fs.floor_price_usd, fs.listing_count,
      fs.days_since_sale, fs.unique_buyers_30d, fs.offer_count,
      fs.velocity_factor, fs.utility_factor, fs.loan_factor,
      e.tier, e.set_name, e.external_id, c.slug AS collection_slug
    FROM editions e
    CROSS JOIN LATERAL (
      SELECT s.*
      FROM fmv_snapshots s
      WHERE s.edition_id = e.id
      ORDER BY s.computed_at DESC
      LIMIT 1
    ) fs
    JOIN collections c ON c.id = fs.collection_id
    WHERE fs.fmv_usd > 200
      AND fs.confidence::text <> 'ASK_ONLY'
  LOOP
    v_total_examined := v_total_examined + 1;
    IF rec.algo_version IN ('thin-sales-guard-v1', 'thin-sales-guard-v2', 'thin-sales-guard-v3') THEN
      v_skipped_already_capped := v_skipped_already_capped + 1;
      CONTINUE;
    END IF;

    v_cap := NULL;
    v_reason := NULL;
    v_new_confidence := NULL;

    SELECT b.low_ask INTO v_fresh_ask
    FROM editions e3
    JOIN badge_editions b ON b.external_id = e3.external_id AND b.collection_id = e3.collection_id
    WHERE e3.id = rec.edition_id AND b.low_ask > 0 AND b.low_ask <= 10000
    ORDER BY b.low_ask ASC
    LIMIT 1;

    IF rec.tier IN ('COMMON','FANDOM') AND rec.fmv_usd > 500 AND COALESCE(rec.sales_count_7d, 0) <= 1 THEN
      SELECT PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY l2.fmv_usd) INTO v_cap
      FROM (
        SELECT DISTINCT ON (edition_id) edition_id, fmv_usd
        FROM fmv_snapshots fs2
        JOIN editions e2 ON e2.id = fs2.edition_id
        WHERE e2.set_name = rec.set_name AND e2.tier = rec.tier
          AND fs2.collection_id = rec.collection_id
          AND fs2.edition_id <> rec.edition_id
          AND fs2.fmv_usd IS NOT NULL AND fs2.fmv_usd > 0
        ORDER BY edition_id, computed_at DESC
      ) l2;
      IF v_cap IS NOT NULL AND v_cap < rec.fmv_usd THEN
        v_cap := GREATEST(v_cap * 5, 50);
        v_cap := LEAST(v_cap, rec.fmv_usd);
        IF v_fresh_ask IS NOT NULL AND ROUND(v_fresh_ask * 0.90, 2) >= v_cap THEN
          v_cap := NULL;
        ELSE
          v_reason := 'common_fandom_outlier';
          v_new_confidence := 'LOW';
          v_common_outlier_count := v_common_outlier_count + 1;
        END IF;
      END IF;
    END IF;

    IF v_cap IS NULL AND v_reason IS NULL AND COALESCE(rec.sales_count_7d, 0) <= 3 AND rec.wap_without_outliers IS NOT NULL THEN
      IF rec.fmv_usd > rec.wap_without_outliers * 5 THEN
        v_can_use_ask := rec.ask_proxy_fmv IS NOT NULL
                       AND rec.ask_proxy_fmv > rec.fmv_usd * 0.30
                       AND rec.ask_proxy_fmv < rec.fmv_usd;
        IF v_can_use_ask THEN
          v_cap := rec.ask_proxy_fmv * 1.5;
          v_reason := 'thin_sales_ask_capped';
        ELSE
          v_cap := rec.wap_without_outliers;
          v_reason := 'thin_sales_wap_capped';
        END IF;
        v_cap := LEAST(v_cap, rec.fmv_usd);
        v_new_confidence := 'MEDIUM';
        v_thin_sales_count := v_thin_sales_count + 1;
      END IF;
    END IF;

    IF v_cap IS NULL AND v_reason IS NULL AND COALESCE(rec.sales_count_30d, 0) = 0 AND rec.fmv_usd > 200 THEN
      IF v_fresh_ask IS NOT NULL THEN
        v_cap := ROUND(v_fresh_ask * 0.90, 2);
        v_reason := 'stale_30d_fresh_ask';
        v_new_confidence := 'ASK_ONLY';
      ELSIF rec.ask_proxy_fmv IS NOT NULL AND rec.ask_proxy_fmv > 50 THEN
        v_cap := LEAST(rec.ask_proxy_fmv * 1.5, rec.fmv_usd);
        v_reason := 'stale_30d_ask_capped';
        v_new_confidence := 'STALE';
      ELSE
        v_cap := rec.fmv_usd;
        v_reason := 'stale_30d_no_ask';
        v_new_confidence := 'STALE';
      END IF;
      v_stale_count := v_stale_count + 1;
    END IF;

    IF v_cap IS NOT NULL AND v_reason IS NOT NULL AND p_mode = 'live' THEN
      INSERT INTO fmv_snapshots (
        edition_id, collection_id, fmv_usd, floor_price_usd,
        asp_usd, asp_without_outliers, ask_proxy_fmv, confidence,
        top_shot_ask, flowty_ask, cross_market_ask,
        sales_count_7d, sales_count_30d, unique_buyers_30d, offer_count, listing_count,
        days_since_sale, velocity_factor, utility_factor, loan_factor,
        algo_version, computed_at
      ) VALUES (
        rec.edition_id, rec.collection_id, v_cap, rec.floor_price_usd,
        rec.wap_usd, rec.wap_without_outliers, COALESCE(v_fresh_ask, rec.ask_proxy_fmv),
        v_new_confidence::fmv_confidence,
        COALESCE(v_fresh_ask, rec.top_shot_ask), rec.flowty_ask, rec.cross_market_ask,
        rec.sales_count_7d, rec.sales_count_30d, rec.unique_buyers_30d,
        rec.offer_count, rec.listing_count,
        rec.days_since_sale, rec.velocity_factor, rec.utility_factor, rec.loan_factor,
        'thin-sales-guard-v3', NOW()
      );

      INSERT INTO fmv_calibration_caps (
        edition_id, collection_id, reason, fmv_before, fmv_after,
        confidence_before, confidence_after, inputs
      ) VALUES (
        rec.edition_id, rec.collection_id, v_reason, rec.fmv_usd, v_cap,
        rec.confidence::TEXT, v_new_confidence,
        jsonb_build_object(
          'tier', rec.tier, 'set_name', rec.set_name,
          'collection_slug', rec.collection_slug,
          'wap_without_outliers', rec.wap_without_outliers,
          'ask_proxy_fmv', rec.ask_proxy_fmv,
          'fresh_ask', v_fresh_ask,
          'sales_count_7d', rec.sales_count_7d,
          'sales_count_30d', rec.sales_count_30d
        )
      )
      ON CONFLICT (edition_id, reason, applied_date) DO UPDATE
        SET applied_at = NOW(),
            fmv_before = EXCLUDED.fmv_before,
            fmv_after = EXCLUDED.fmv_after,
            confidence_before = EXCLUDED.confidence_before,
            confidence_after = EXCLUDED.confidence_after,
            inputs = EXCLUDED.inputs;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'mode', p_mode, 'ran_at', NOW(),
    'algo_version', 'thin-sales-guard-v3',
    'total_examined', v_total_examined,
    'skipped_already_capped', v_skipped_already_capped,
    'thin_sales_count', v_thin_sales_count,
    'stale_count', v_stale_count,
    'common_outlier_count', v_common_outlier_count,
    'total_caps_applied', v_thin_sales_count + v_stale_count + v_common_outlier_count
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_fmv_thin_sales_guard(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_fmv_thin_sales_guard(text) FROM anon;
REVOKE ALL ON FUNCTION public.apply_fmv_thin_sales_guard(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_fmv_thin_sales_guard(text) TO service_role;

-- Post-condition: the new cursor is live, the old one is gone, the default survived, and the ACL is
-- exactly what it was.
DO $post$
DECLARE v_src text; v_acl text; v_args text;
BEGIN
  SELECT p.prosrc, p.proacl::text, pg_get_function_arguments(p.oid)
    INTO v_src, v_acl, v_args
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'apply_fmv_thin_sales_guard';

  IF v_src NOT LIKE '%CROSS JOIN LATERAL%' THEN
    RAISE EXCEPTION 'post-condition failed: LATERAL cursor not present';
  END IF;
  IF v_src LIKE '%SELECT l.*, e.tier%' THEN
    RAISE EXCEPTION 'post-condition failed: the DISTINCT ON cursor is still present';
  END IF;
  IF v_args NOT LIKE '%DEFAULT ''dry_run''%' THEN
    RAISE EXCEPTION 'post-condition failed: the dry_run default was lost (args=%)', v_args;
  END IF;
  IF v_acl LIKE '%anon=%' OR v_acl LIKE '%authenticated=%' THEN
    RAISE EXCEPTION 'post-condition failed: anon/authenticated gained EXECUTE (acl=%)', v_acl;
  END IF;
  IF v_acl NOT LIKE '%service_role=X%' THEN
    RAISE EXCEPTION 'post-condition failed: service_role lost EXECUTE (acl=%)', v_acl;
  END IF;
END
$post$;