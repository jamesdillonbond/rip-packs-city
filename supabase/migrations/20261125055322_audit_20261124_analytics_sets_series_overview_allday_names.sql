-- anon-exec: unchanged (analytics_sets_series_overview) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false authenticated=false 2026-11-24.
CREATE OR REPLACE FUNCTION public.analytics_sets_series_overview(p_collections text[] DEFAULT NULL::text[])
 RETURNS TABLE(collection text, series smallint, series_label text, set_count bigint, edition_count bigint, edition_count_with_fmv bigint, median_edition_fmv numeric, total_series_fmv_robust numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  WITH latest_fmv AS (
    SELECT DISTINCT ON (s.edition_id)
      s.edition_id, s.fmv_usd
    FROM fmv_snapshots_2026 s
    WHERE s.computed_at >= now() - interval '24 hours'
      AND s.confidence != 'ASK_ONLY'
    ORDER BY s.edition_id, s.computed_at DESC
  ),
  normalized AS (
    SELECT
      (CASE c.slug
        WHEN 'nba_top_shot'   THEN 'topshot'
        WHEN 'nfl_all_day'    THEN 'allday'
        WHEN 'laliga_golazos' THEN 'golazos'
        WHEN 'ufc_strike'     THEN 'ufc'
        ELSE c.slug
      END)::text                          AS x_coll,
      e.series                            AS x_series,
      s.id                                AS x_sid,
      e.id                                AS x_eid,
      f.fmv_usd                           AS x_fmv
    FROM sets s
    JOIN collections c ON c.id = s.collection_id
    JOIN editions e ON e.set_id = s.id
    LEFT JOIN latest_fmv f ON f.edition_id = e.id
    WHERE (p_collections IS NULL OR
           (CASE c.slug
             WHEN 'nba_top_shot'   THEN 'topshot'
             WHEN 'nfl_all_day'    THEN 'allday'
             WHEN 'laliga_golazos' THEN 'golazos'
             WHEN 'ufc_strike'     THEN 'ufc'
             ELSE c.slug
           END)::text = ANY(p_collections))
  ),
  per_series_median AS (
    SELECT
      x_coll, x_series,
      ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x_fmv)::numeric, 2) AS median_fmv
    FROM normalized
    GROUP BY x_coll, x_series
  )
  SELECT
    n.x_coll                              AS collection,
    n.x_series                            AS series,
    -- Canonical Top Shot series labels for the on-chain UInt32 values.
    -- series=1 is anomalous (likely UUID-edition ingestion artifacts) and labeled to reflect that.
    CASE
      WHEN n.x_coll = 'topshot' THEN
        CASE n.x_series
          WHEN 0 THEN 'Series 1'
          WHEN 1 THEN 'Misc / Unmapped'
          WHEN 2 THEN 'Series 2'
          WHEN 3 THEN 'Summer 2021'
          WHEN 4 THEN 'Series 3'
          WHEN 5 THEN 'Series 4'
          WHEN 6 THEN 'Series 2023-24'
          WHEN 7 THEN 'Series 2024-25'
          WHEN 8 THEN 'Series 2025-26'
          WHEN 9 THEN 'Series 2026-27'
          ELSE 'Series ' || n.x_series::text
        END
      -- NFL All Day (2026-11-24): the contract's own series names (AllDay.getSeriesData),
      -- mirrored by series_display_label() and ALLDAY_SERIES_DISPLAY in lib/series-label.ts.
      WHEN n.x_coll = 'allday' THEN
        CASE n.x_series
          WHEN 1 THEN 'Series 1'
          WHEN 2 THEN 'Historical'
          WHEN 3 THEN 'Series 2'
          WHEN 4 THEN 'Historical 2'
          WHEN 5 THEN '2023 Season'
          WHEN 6 THEN 'Historical (2024 Release)'
          WHEN 7 THEN '2024 Season'
          WHEN 8 THEN 'Historical (2025 Release)'
          WHEN 9 THEN '2025 Season'
          WHEN 10 THEN 'Historical (2026 Release)'
          ELSE 'Series ' || COALESCE(n.x_series::text, '?')
        END
      ELSE 'Series ' || COALESCE(n.x_series::text, '?')
    END                                   AS series_label,
    COUNT(DISTINCT n.x_sid)::bigint       AS set_count,
    COUNT(DISTINCT n.x_eid)::bigint       AS edition_count,
    COUNT(DISTINCT n.x_eid) FILTER (WHERE n.x_fmv IS NOT NULL)::bigint AS edition_count_with_fmv,
    psm.median_fmv                        AS median_edition_fmv,
    ROUND(SUM(LEAST(COALESCE(n.x_fmv, 0), COALESCE(psm.median_fmv, 0) * 20))::numeric, 2)
                                          AS total_series_fmv_robust
  FROM normalized n
  LEFT JOIN per_series_median psm
         ON psm.x_coll = n.x_coll AND psm.x_series = n.x_series
  GROUP BY n.x_coll, n.x_series, psm.median_fmv
  ORDER BY n.x_coll, n.x_series;
END;
$function$;
