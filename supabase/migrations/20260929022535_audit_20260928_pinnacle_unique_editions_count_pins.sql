-- audit_20260928_pinnacle_unique_editions_count_pins
--
-- /api/market-analytics?collection=disney-pinnacle takes its period KPIs from
-- pinnacle_period_comparison, which counted `DISTINCT edition_id`. On
-- pinnacle_sales that is the SET-LEVEL key (one per set/variant), so the
-- Analytics "Unique Editions" KPI read 385 for the last 30 days where 1,482
-- distinct pins sold. Now `DISTINCT render_id` (the pin), the grain every other
-- Pinnacle surface counts. Sales, volume and average price are unchanged.
--
-- anon-exec: intentional — SECURITY INVOKER read of public sales aggregates, grants unchanged (pinnacle_period_comparison)
--
-- Pin: supabase/tests/pinnacle_period_comparison.sql (DDL verbatim).
-- Revert: the same body with `render_id` → `edition_id` in both CTEs.

CREATE OR REPLACE FUNCTION public.pinnacle_period_comparison(p_days integer DEFAULT 7)
 RETURNS json
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- 2026-09-28: uniqueEditions counts distinct PINS (render_id). It counted
  -- pinnacle_sales.edition_id, the set-level key (one per set/variant), so the
  -- Analytics "Unique Editions" KPI read 385 where 1,482 pins sold in 30 days.
  WITH current_period AS (
    SELECT
      count(*)::int AS sales,
      COALESCE(round(sum(sale_price_usd)::numeric, 2), 0) AS volume,
      COALESCE(round(avg(sale_price_usd)::numeric, 2), 0) AS avg_price,
      count(DISTINCT render_id)::int AS unique_editions
    FROM pinnacle_sales
    WHERE sold_at >= now() - (p_days || ' days')::interval
      AND sale_price_usd > 0
  ),
  previous_period AS (
    SELECT
      count(*)::int AS sales,
      COALESCE(round(sum(sale_price_usd)::numeric, 2), 0) AS volume,
      COALESCE(round(avg(sale_price_usd)::numeric, 2), 0) AS avg_price,
      count(DISTINCT render_id)::int AS unique_editions
    FROM pinnacle_sales
    WHERE sold_at >= now() - (p_days * 2 || ' days')::interval
      AND sold_at < now() - (p_days || ' days')::interval
      AND sale_price_usd > 0
  )
  SELECT json_build_object(
    'current', json_build_object(
      'sales', c.sales, 'volume', c.volume,
      'avgPrice', c.avg_price, 'uniqueEditions', c.unique_editions
    ),
    'previous', json_build_object(
      'sales', p.sales, 'volume', p.volume,
      'avgPrice', p.avg_price, 'uniqueEditions', p.unique_editions
    ),
    'changes', json_build_object(
      'salesPct', CASE WHEN p.sales > 0 THEN round(((c.sales - p.sales)::numeric / p.sales) * 100, 1) ELSE null END,
      'volumePct', CASE WHEN p.volume > 0 THEN round(((c.volume - p.volume) / p.volume) * 100, 1) ELSE null END,
      'avgPricePct', CASE WHEN p.avg_price > 0 THEN round(((c.avg_price - p.avg_price) / p.avg_price) * 100, 1) ELSE null END,
      'uniqueEditionsPct', CASE WHEN p.unique_editions > 0 THEN round(((c.unique_editions - p.unique_editions)::numeric / p.unique_editions) * 100, 1) ELSE null END
    )
  )
  FROM current_period c, previous_period p;
$function$;
