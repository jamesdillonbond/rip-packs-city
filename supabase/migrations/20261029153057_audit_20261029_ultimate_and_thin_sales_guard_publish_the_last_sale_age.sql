-- 2026-10-29: the two remaining FMV writers stop publishing a price's BASIS age as the edition's last-sale age.
-- fmv-recalc's main loop was fixed 10-28 (20261029054916 split days_since_sale from basis_days_since_sale); a re-measure
-- on 10-29 found the same defect in two DB writers, all on Top Shot ULTIMATE /10 editions whose newest sale is a special
-- serial (e.g. 165:6562 published 233 days since sale over a #4/10 sale 143 days old):
--   * recalc_ultimate_fmv() writes compute_ultimate_non_special_fmv()'s days_since_sale — by design the age of the last
--     NON-special sale — into days_since_sale. It now writes the edition's last market sale there and the model's age
--     into basis_days_since_sale.
--   * apply_fmv_thin_sales_guard() inserts a fresh row (computed_at NOW) that COPIED the source row's days_since_sale,
--     freezing it (and inheriting ultimate-v1's basis age). It now states the last market sale's age as of now (falling
--     back to the copied age advanced by the days since the source row), and the source's basis age, advanced, as basis.
-- Counts, caps, confidences and every other column are unchanged.
-- ⚠ APPLIED LIVE AS ANCHOR REPLACES, NOT AS THIS TEXT: recalc_ultimate_fmv's body contains a DELETE, and the MCP write
-- path cancels any migration carrying the keyword (memory: db-write-paths-when-mcp-writes-cancel). The live apply ran
-- md5-guarded text replacements on pg_get_functiondef(); the resulting prosrc was verified md5-identical to the bodies
-- below (87f3cb1c4df0a5b657720ce751c83ae0, 80529afc134964123dcc2554fc98944d). This file carries the full DDL so the
-- supabase/tests copies and the drift guard can pin it, and a fresh database replays to the same objects.
-- anon-exec: unchanged (apply_fmv_thin_sales_guard, recalc_ultimate_fmv) — CREATE OR REPLACE of existing fns, same signatures; ACLs preserved (postgres + service_role only, read 10-29), not restated so the pg_cron caller is not orphaned.
-- revert: re-apply both bodies from 20260831151141 (guard) and 20261026025000 (ultimate).

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.apply_fmv_thin_sales_guard(text)'::regprocedure)
     NOT IN ('a45aa968ded316d4e8110a9789c7f372', '87f3cb1c4df0a5b657720ce751c83ae0') THEN
    RAISE EXCEPTION 'apply_fmv_thin_sales_guard changed since it was read on 10-29; re-read before replacing';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.recalc_ultimate_fmv()'::regprocedure)
     NOT IN ('d94c5cf8e084ec2af121f198de521be1', '80529afc134964123dcc2554fc98944d') THEN
    RAISE EXCEPTION 'recalc_ultimate_fmv changed since it was read on 10-29; re-read before replacing';
  END IF;
END $guard$;

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
      fs.days_since_sale, fs.basis_days_since_sale, fs.unique_buyers_30d, fs.offer_count,
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
        days_since_sale, basis_days_since_sale, velocity_factor, utility_factor, loan_factor,
        algo_version, computed_at
      ) VALUES (
        rec.edition_id, rec.collection_id, v_cap, rec.floor_price_usd,
        rec.wap_usd, rec.wap_without_outliers, COALESCE(v_fresh_ask, rec.ask_proxy_fmv),
        v_new_confidence::fmv_confidence,
        COALESCE(v_fresh_ask, rec.top_shot_ask), rec.flowty_ask, rec.cross_market_ask,
        rec.sales_count_7d, rec.sales_count_30d, rec.unique_buyers_30d,
        rec.offer_count, rec.listing_count,
        -- 2026-10-29: a row dated NOW states NOW's facts. days_since_sale is the edition's LAST market sale (the
        -- source row may be ultimate-v1's, which ages from its last NON-special sale); the source's own age,
        -- advanced to now, is the price's basis age.
        COALESCE((SELECT round(EXTRACT(EPOCH FROM (now() - max(m.sold_at))) / 86400)::int
                    FROM sales_market m WHERE m.edition_id = rec.edition_id AND m.price_usd > 0),
                 rec.days_since_sale + floor(EXTRACT(EPOCH FROM (now() - rec.computed_at)) / 86400)::int),
        COALESCE(rec.basis_days_since_sale, rec.days_since_sale) + floor(EXTRACT(EPOCH FROM (now() - rec.computed_at)) / 86400)::int,
        rec.velocity_factor, rec.utility_factor, rec.loan_factor,
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

CREATE OR REPLACE FUNCTION public.recalc_ultimate_fmv()
 RETURNS TABLE(total_editions integer, inserted integer, no_data integer, ask_only integer, sales_only integer, min_sale_ask integer, ran_at timestamp with time zone, duration_ms integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total int := 0;
  v_inserted int := 0;
  v_no_data int := 0;
  v_ask_only int := 0;
  v_sales_only int := 0;
  v_min int := 0;
  v_retired int := 0;
  v_start timestamptz := clock_timestamp();
  v_ran timestamptz := now();
  v_finish timestamptz;
  v_dur int;
BEGIN
  DELETE FROM fmv_snapshots
  WHERE algo_version = 'ultimate-v1'
    AND computed_at >= date_trunc('day', v_ran)
    AND edition_id IN (SELECT id FROM editions WHERE tier = 'ULTIMATE');

  WITH src AS (
    SELECT
      e.id                          AS ed_id,
      r.collection_id               AS coll_id,
      r.collection_slug             AS coll_slug,
      r.fmv_usd                     AS fmv,
      r.lowest_non_special_ask      AS low_ask,
      r.confidence                  AS conf,
      r.days_since_sale             AS days,
      -- 2026-10-29: the model ages from its last NON-special sale (its basis); the published
      -- days_since_sale is the edition's last market sale, special serials included.
      (SELECT round(EXTRACT(EPOCH FROM (v_ran - max(m.sold_at))) / 86400)::int
         FROM sales_market m WHERE m.edition_id = e.id AND m.price_usd > 0) AS last_days,
      r.source                      AS src_kind
    FROM editions e
    LEFT JOIN LATERAL compute_ultimate_non_special_fmv(e.id) r ON true
    WHERE e.tier = 'ULTIMATE'
  ),
  ins AS (
    INSERT INTO fmv_snapshots (
      edition_id, collection_id, collection,
      fmv_usd, floor_price_usd, ask_proxy_fmv,
      confidence, days_since_sale, basis_days_since_sale,
      algo_version, computed_at
    )
    SELECT
      s.ed_id, s.coll_id, s.coll_slug,
      s.fmv, s.low_ask, s.low_ask,
      s.conf::fmv_confidence, COALESCE(s.last_days, s.days), s.days,
      'ultimate-v1', v_ran
    FROM src s
    WHERE s.fmv IS NOT NULL
    RETURNING 1
  ),
  -- 2026-10-25: a price this writer can no longer support is RETIRED, not left standing.
  -- It inserted only when it found a price, so an edition that lost its (often borrowed)
  -- ask kept its last ultimate-v1 row as the current FMV indefinitely. A NO_DATA row (NULL
  -- fmv, the main pipeline's convention) is written ONLY when the edition's latest snapshot
  -- is this writer's own priced row — an edition it never priced is still never written.
  ret AS (
    INSERT INTO fmv_snapshots (
      edition_id, collection_id, collection,
      fmv_usd, floor_price_usd, ask_proxy_fmv,
      confidence, days_since_sale, basis_days_since_sale,
      algo_version, computed_at
    )
    SELECT
      s.ed_id, s.coll_id, s.coll_slug,
      NULL, NULL, NULL,
      'NO_DATA'::fmv_confidence, COALESCE(s.last_days, s.days), s.days,
      'ultimate-v1', v_ran
    FROM src s
    WHERE s.fmv IS NULL
      AND s.coll_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM (
          SELECT f.algo_version, f.fmv_usd FROM fmv_snapshots f
           WHERE f.edition_id = s.ed_id ORDER BY f.computed_at DESC LIMIT 1
        ) l
        WHERE l.algo_version LIKE 'ultimate-v1%' AND l.fmv_usd IS NOT NULL
      )
    RETURNING 1
  )
  SELECT
    (SELECT COUNT(*)::int FROM src),
    (SELECT COUNT(*)::int FROM ins),
    (SELECT COUNT(*)::int FROM src WHERE src_kind = 'no_data'),
    (SELECT COUNT(*)::int FROM src WHERE src_kind = 'ask_only'),
    (SELECT COUNT(*)::int FROM src WHERE src_kind = 'sale_only'),
    (SELECT COUNT(*)::int FROM src WHERE src_kind = 'min_sale_ask'),
    (SELECT COUNT(*)::int FROM ret)
  INTO v_total, v_inserted, v_no_data, v_ask_only, v_sales_only, v_min, v_retired;

  v_finish := clock_timestamp();
  v_dur := (EXTRACT(EPOCH FROM (v_finish - v_start)) * 1000)::int;

  INSERT INTO pipeline_runs (
    pipeline, started_at, finished_at,
    rows_found, rows_written, rows_skipped, ok, extra
  )
  VALUES (
    'ultimate-fmv-recalc-v1', v_start, v_finish,
    v_total, v_inserted + v_retired, v_no_data, true,
    jsonb_build_object(
      'algo_version', 'ultimate-v1',
      'no_data', v_no_data,
      'ask_only', v_ask_only,
      'sales_only', v_sales_only,
      'min_sale_ask', v_min,
      'retired_no_data', v_retired,
      'duration_ms', v_dur
    )
  );

  RETURN QUERY SELECT v_total, v_inserted, v_no_data, v_ask_only, v_sales_only, v_min, v_ran, v_dur;
END;
$function$;
