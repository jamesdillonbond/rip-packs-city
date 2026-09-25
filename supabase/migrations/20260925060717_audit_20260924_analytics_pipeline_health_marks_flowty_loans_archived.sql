-- 2026-09-24 (PT) — /analytics has carried the badge "1 pipeline stale" since
-- Flowty's marketplace closed (May 2026): analytics_pipeline_health() still
-- graded the loan indexer against a 15-minute cadence (lag 195,925 min at the
-- time of writing) and folded it into overall_status, so the badge is
-- permanently red — the estate's own "permanently-red instrument" class,
-- which hides a REAL stale pipeline behind a known one. The Loans section of
-- the page already says HISTORICAL.
--
-- Change: the loans row keeps its measured lag but reports status 'archived'
-- with an honest cadence string, and overall_status is computed over the live
-- pipelines only (sales, fmv — unchanged set). Everything else is byte-identical
-- to the live body read at 11:1x PM PT.
-- anon-exec: intentional — SNAPSHOT of analytics_pipeline_health, an existing SECURITY DEFINER public read whose ACL is unchanged by CREATE OR REPLACE (the /analytics page reads it via the service role).
-- Revert: re-apply the previous body (loans graded on the 15-min ladder and
-- included in overall_status).
CREATE OR REPLACE FUNCTION public.analytics_pipeline_health()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET statement_timeout TO '5s'
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  result jsonb;
  loan_lag    int;
  sales_lag   int;
  pack_lag    int;
  fmv_lag     int;
  listings_lag int;
  v_latest_sale     timestamptz;
  v_latest_pinnacle timestamptz;
BEGIN
  SELECT EXTRACT(EPOCH FROM (now() - updated_at))::int / 60
    INTO loan_lag
    FROM scan_checkpoint WHERE key = 'flowty_loans_indexer';

  -- Sales: query each underlying partition directly with LIMIT 1.
  -- The 24h window predicate ensures the descending index scan terminates immediately.
  SELECT sold_at INTO v_latest_sale
  FROM sales_2026
  WHERE sold_at >= now() - interval '24 hours'
  ORDER BY sold_at DESC
  LIMIT 1;

  SELECT sold_at INTO v_latest_pinnacle
  FROM pinnacle_sales
  WHERE sold_at >= now() - interval '24 hours'
  ORDER BY sold_at DESC
  LIMIT 1;

  -- If both are null (no sales in last 24h), set lag to a high value (fall back to slow path)
  IF v_latest_sale IS NULL AND v_latest_pinnacle IS NULL THEN
    sales_lag := 1440;  -- 24 hours, will register as 'stale'
  ELSE
    sales_lag := EXTRACT(EPOCH FROM (
      now() - GREATEST(COALESCE(v_latest_sale, '1970-01-01'::timestamptz),
                       COALESCE(v_latest_pinnacle, '1970-01-01'::timestamptz))
    ))::int / 60;
  END IF;

  -- FMV: same LIMIT 1 ORDER BY DESC pattern
  SELECT EXTRACT(EPOCH FROM (now() - computed_at))::int / 60
    INTO fmv_lag
    FROM fmv_snapshots_2026
    WHERE computed_at >= now() - interval '24 hours'
    ORDER BY computed_at DESC
    LIMIT 1;

  fmv_lag := COALESCE(fmv_lag, 1440);

  SELECT EXTRACT(EPOCH FROM (now() - snapshotted_at))::int / 60
    INTO pack_lag
    FROM pack_ev_history
    WHERE snapshotted_at >= now() - interval '7 days'
    ORDER BY snapshotted_at DESC
    LIMIT 1;

  pack_lag := COALESCE(pack_lag, 10080);

  SELECT EXTRACT(EPOCH FROM (now() - cached_at))::int / 60
    INTO listings_lag
    FROM cached_listings
    WHERE cached_at >= now() - interval '24 hours'
    ORDER BY cached_at DESC
    LIMIT 1;

  listings_lag := COALESCE(listings_lag, 1440);

  result := jsonb_build_object(
    'pipelines', jsonb_build_object(
      -- 2026-09-24: Flowty closed (May 2026) — the loan book is a historical
      -- archive, not a lagging feed. Reported, never graded.
      'loans',    jsonb_build_object(
        'lag_minutes', loan_lag,
        'expected_max_lag_min', 15,
        'status', 'archived',
        'cadence', 'historical archive — Flowty closed May 2026'
      ),
      'sales',    jsonb_build_object(
        'lag_minutes', sales_lag,
        'expected_max_lag_min', 30,
        'status', CASE WHEN sales_lag <= 30 THEN 'healthy' WHEN sales_lag <= 120 THEN 'degraded' ELSE 'stale' END,
        'cadence', 'continuous'
      ),
      'fmv',      jsonb_build_object(
        'lag_minutes', fmv_lag,
        'expected_max_lag_min', 30,
        'status', CASE WHEN fmv_lag <= 30 THEN 'healthy' WHEN fmv_lag <= 120 THEN 'degraded' ELSE 'stale' END,
        'cadence', '~10-15 minutes'
      ),
      'pack_ev',  jsonb_build_object(
        'lag_minutes', pack_lag,
        'expected_max_lag_min', 60,
        'status', CASE WHEN pack_lag <= 60 THEN 'healthy' WHEN pack_lag <= 240 THEN 'degraded' ELSE 'stale' END,
        'cadence', '~30 minutes (rotation-based)'
      ),
      'listings', jsonb_build_object(
        'lag_minutes', listings_lag,
        'expected_max_lag_min', 30,
        'status', CASE WHEN listings_lag <= 30 THEN 'healthy' WHEN listings_lag <= 120 THEN 'degraded' ELSE 'stale' END,
        'cadence', '~10-15 minutes'
      )
    ),
    'overall_status', CASE
      WHEN GREATEST(sales_lag, fmv_lag) > 120 THEN 'stale'
      WHEN GREATEST(sales_lag, fmv_lag) > 30  THEN 'degraded'
      ELSE 'healthy'
    END,
    'as_of', now()
  );

  RETURN result;
END;
$function$;

DO $$
DECLARE v jsonb;
BEGIN
  v := public.analytics_pipeline_health();
  IF v->'pipelines'->'loans'->>'status' IS DISTINCT FROM 'archived' THEN
    RAISE EXCEPTION 'loans not archived';
  END IF;
END $$;
