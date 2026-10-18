-- 2026-10-18 (Claude Code cloud) — get_wallet_tc_report's WNBA section covers the CURRENT WNBA season.
--
-- WHY: Section 3 hard-coded `s.series = 7` (Series 2024-25: 16 WNBA sets, 406 editions). The
-- /insights/tc-report page labels it plainly "WNBA Sets N of M", so every report left out the
-- 2025-26 WNBA season (series 8: 17 sets, 1,038 editions, created 2026-06-04 → 09-28) and stated a
-- collector's coverage against last year's sets. Now the latest Top Shot series that has WNBA sets,
-- returned as `wnba_coverage.series` so the page can name it. Everything else is byte-identical to
-- 20260925050824 (live md5 of the whitespace-normalised prosrc verified equal before this edit).
--
-- anon-exec: intentional — CREATE OR REPLACE of get_wallet_tc_report (same signature); its ACL (service_role only, set 2026-07-31) is preserved.

CREATE OR REPLACE FUNCTION public.get_wallet_tc_report(p_wallet text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_wallet text := LOWER(p_wallet);
  v_rollup jsonb;
  v_rookie jsonb;
  v_wnba jsonb;
  v_top_sets jsonb;
  v_acquisitions jsonb;
BEGIN
  -- ── Section 1: per-collection rollup (moments + editions + approx FMV) ──
  WITH rollup AS (
    SELECT
      c.slug,
      COUNT(*) AS moments,
      COUNT(DISTINCT w.edition_key) AS editions,
      ROUND(SUM(COALESCE(w.fmv_usd, 0))::numeric, 2) AS approx_fmv_usd
    FROM wallet_moments_cache w
    JOIN collections c ON c.id = w.collection_id
    WHERE w.wallet_address = v_wallet
    GROUP BY c.slug
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'slug', slug,
    'moments', moments,
    'editions', editions,
    'approx_fmv_usd', approx_fmv_usd
  ) ORDER BY moments DESC), '[]'::jsonb)
  INTO v_rollup FROM rollup;

  -- ── Section 2: 2025 rookie coverage ───────────────────────────────────
  WITH cohort AS (SELECT player_name FROM topshot_2025_rookie_players),
  owned AS (
    SELECT DISTINCT e.player_name
    FROM wallet_moments_cache w
    JOIN editions e ON e.external_id::text = w.edition_key AND e.collection_id = w.collection_id
    WHERE w.wallet_address = v_wallet
      AND w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND e.player_name IN (SELECT player_name FROM cohort)
  ),
  best AS (
    SELECT e.player_name, e.set_name, e.tier::text AS tier, w.serial_number,
      ROW_NUMBER() OVER (
        ORDER BY (w.serial_number = 1) DESC, e.tier DESC, w.serial_number ASC
      ) AS rk
    FROM wallet_moments_cache w
    JOIN editions e ON e.external_id::text = w.edition_key AND e.collection_id = w.collection_id
    WHERE w.wallet_address = v_wallet
      AND w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND e.player_name IN (SELECT player_name FROM cohort)
  )
  SELECT jsonb_build_object(
    'cohort_size',  (SELECT COUNT(*) FROM cohort),
    'owned_count',  (SELECT COUNT(*) FROM owned),
    'best_holding', (SELECT jsonb_build_object(
                      'player_name', player_name,
                      'set_name',    set_name,
                      'tier',        tier,
                      'serial',      serial_number
                    ) FROM best WHERE rk = 1)
  ) INTO v_rookie;

  -- ── Section 3: WNBA coverage (the LATEST Top Shot series with WNBA sets) ─
  -- 2026-10-18: was hard-coded `s.series = 7` (2024-25: 16 sets / 406 editions) while the page
  -- reads a generic "WNBA Sets" — so it left out the current WNBA season (series 8: 17 sets /
  -- 1,038 editions). Derived, so it advances by itself; `series` is returned for the label.
  WITH wnba_series AS (
    SELECT max(s.series) AS n
    FROM sets s
    WHERE s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND s.name ILIKE '%wnba%'
  ),
  wnba_sets AS (
    SELECT s.id, s.name AS set_name, COUNT(DISTINCT e.id) AS set_total_eds
    FROM sets s
    JOIN editions e ON e.set_id = s.id
    WHERE s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND s.series = (SELECT n FROM wnba_series)
      AND s.name ILIKE '%wnba%'
    GROUP BY s.id, s.name
  ),
  wallet_wnba AS (
    SELECT s.id AS set_id, COUNT(DISTINCT e.id) AS owned_eds
    FROM wallet_moments_cache w
    JOIN editions e ON e.external_id::text = w.edition_key AND e.collection_id = w.collection_id
    JOIN sets s ON s.id = e.set_id
    WHERE w.wallet_address = v_wallet
      AND w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND s.series = (SELECT n FROM wnba_series)
      AND s.name ILIKE '%wnba%'
    GROUP BY s.id
  )
  SELECT jsonb_build_object(
    'series',      (SELECT n FROM wnba_series),
    'series_label', public.series_display_label('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, (SELECT n FROM wnba_series)::int),
    'sets_total',  (SELECT COUNT(*) FROM wnba_sets),
    'sets_touched', (SELECT COUNT(*) FROM wallet_wnba),
    'editions_in_cohort_total', (SELECT SUM(set_total_eds) FROM wnba_sets),
    'editions_owned',           (SELECT COALESCE(SUM(owned_eds), 0) FROM wallet_wnba),
    'per_set', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'set_name', ws.set_name,
        'set_total_eds', ws.set_total_eds,
        'owned_eds', COALESCE(ww.owned_eds, 0),
        'completion_pct', ROUND(100.0 * COALESCE(ww.owned_eds, 0) / NULLIF(ws.set_total_eds, 0), 1)
      ) ORDER BY COALESCE(ww.owned_eds, 0) DESC, ws.set_total_eds DESC), '[]'::jsonb)
      FROM wnba_sets ws
      LEFT JOIN wallet_wnba ww ON ww.set_id = ws.id
    )
  ) INTO v_wnba;

  -- ── Section 4: top 5 most-held TS sets with completion ─────────────────
  -- 2026-09-24: carries the set's SERIES so same-named sets ("Base Set" ×4
  -- for any long-time collector) are distinguishable on the report.
  WITH wallet_set_holdings AS (
    SELECT s.id AS set_id, s.name AS set_name, s.series AS series,
      COUNT(DISTINCT e.id) AS owned_eds,
      SUM(1) AS total_moments
    FROM wallet_moments_cache w
    JOIN editions e ON e.external_id::text = w.edition_key AND e.collection_id = w.collection_id
    JOIN sets s ON s.id = e.set_id
    WHERE w.wallet_address = v_wallet
      AND w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    GROUP BY s.id, s.name, s.series
    ORDER BY total_moments DESC
    LIMIT 5
  ),
  set_totals AS (
    SELECT s.id, COUNT(DISTINCT e.id) AS set_total
    FROM sets s JOIN editions e ON e.set_id = s.id
    WHERE s.id IN (SELECT set_id FROM wallet_set_holdings)
    GROUP BY s.id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'set_name', wsh.set_name,
    'series', wsh.series,
    'series_label', public.series_display_label('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, wsh.series::int),
    'owned_eds', wsh.owned_eds,
    'set_total_eds', st.set_total,
    'completion_pct', ROUND(100.0 * wsh.owned_eds / NULLIF(st.set_total, 0), 1),
    'total_moments_held', wsh.total_moments
  ) ORDER BY wsh.total_moments DESC), '[]'::jsonb)
  INTO v_top_sets
  FROM wallet_set_holdings wsh
  LEFT JOIN set_totals st ON st.id = wsh.set_id;

  -- ── Section 5: recent 90d acquisitions (TS sales TO this wallet) ───────
  WITH recent AS (
    SELECT s.sold_at, s.price_usd, s.serial_number, e.player_name, e.set_name, e.tier::text AS tier
    FROM sales s
    JOIN editions e ON e.id = s.edition_id
    WHERE s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND s.buyer_address = v_wallet
      AND s.sold_at >= NOW() - INTERVAL '90 days'
      AND s.price_usd > 0
    ORDER BY s.sold_at DESC
    LIMIT 10
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'sold_at',     sold_at,
    'price_usd',   ROUND(price_usd, 2),
    'player_name', player_name,
    'set_name',    set_name,
    'tier',        tier,
    'serial',      serial_number
  ) ORDER BY sold_at DESC), '[]'::jsonb)
  INTO v_acquisitions FROM recent;

  RETURN jsonb_build_object(
    'wallet',              v_wallet,
    'computed_at',         NOW(),
    'cross_collection',    v_rollup,
    'squeeze',             public.get_wallet_squeeze_exposure(v_wallet),
    'rookie_coverage',     v_rookie,
    'wnba_coverage',       v_wnba,
    'top_sets',            v_top_sets,
    'recent_acquisitions', v_acquisitions
  );
END;
$function$;

