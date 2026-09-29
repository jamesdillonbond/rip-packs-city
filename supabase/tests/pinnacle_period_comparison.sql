-- DB invariant: public.pinnacle_period_comparison — the Pinnacle Analytics
-- period KPIs. Added 2026-09-28: uniqueEditions counted the set-level
-- edition_id, reading 385 where 1,482 pins sold.
--
-- Claims:
--   1. uniqueEditions counts distinct pins (render_id), not distinct set keys.
--   2. Sales / volume / previous-period split are unchanged.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260929022535_audit_20260928_pinnacle_unique_editions_count_pins.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pinnacle_sales (edition_id text, render_id text, sale_price_usd numeric, sold_at timestamptz);

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

INSERT INTO public.pinnacle_sales VALUES
  ('SET-A', 'r1', 10, now() - interval '1 day'),
  ('SET-A', 'r2', 20, now() - interval '2 days'),   -- same set key, different pin
  ('SET-A', 'r2', 30, now() - interval '3 days'),
  ('SET-B', 'r3',  5, now() - interval '10 days'),  -- previous period
  ('SET-B', 'r4',  0, now() - interval '1 day');    -- $0: excluded

SELECT _assert_eq((public.pinnacle_period_comparison(7)->'current'->>'uniqueEditions'), '2', 'two distinct pins sold, under one set key');
SELECT _assert_eq((public.pinnacle_period_comparison(7)->'current'->>'sales'), '3', 'sales count unchanged');
SELECT _assert_eq((public.pinnacle_period_comparison(7)->'current'->>'volume'), '60.00', 'volume unchanged');
SELECT _assert_eq((public.pinnacle_period_comparison(7)->'previous'->>'uniqueEditions'), '1', 'previous period counted separately');

SELECT '✓ pinnacle_period_comparison: all assertions passed' AS result;

ROLLBACK;
