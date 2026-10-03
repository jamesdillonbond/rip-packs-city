-- audit_20261003_fmv_sales_backtest_any_collection
--
-- The same instrument as topshot_fmv_backtest (20261003223807) for ANY
-- sales-priced collection, plus the DOLLAR error beside the percentage.
-- topshot_fmv_backtest stays as it is (a DROP to turn it into a wrapper was
-- refused by the session's permission layer; its body is identical minus the
-- usd column — change both or neither). Why the usd column: measured on All Day the same hour, 93 % of sales are under $1
-- (median price $0.15–0.50, prices quantised to 5-cent ticks), so a "44 %
-- miss" there is $0.10 — the percentage alone misreads a penny market.
--
-- All Day, out of sample (FMV published >= 1 day before the sale), PT weeks
-- to 2026-10-03: week 0 (n 4,992) published median abs err 26.7 % / $0.05,
-- ratio 1.200; week 1 25.0 % / 0.882; week 2 (09-12 → 09-19, the drop week,
-- n 5,759) 45.0 % / ratio 0.571 — FMV was 43 % BELOW realized across 2,800+
-- editions incl. liquid ones ($0.75 low on $1–5 items, $4 low on >= $5 items);
-- week 3 33.3 % / 0.741. Snapshots were fresh (median 1.5 d) and ingestion
-- lag is minutes, so this is the estimator lagging a market that moves 2× in
-- days around a drop, not a pipeline artefact. The last-3 median lags too
-- (0.789 that week) — only less.
--
-- Columns: estimator (published | last3_median_30d), confidence (tier or ALL),
-- n, median_abs_err_pct, within_25_pct, median_ratio, median_abs_err_usd.
-- Sell-back exclusion applies only to Top Shot's buy-back wallet; other
-- collections have no equivalent custodial buyer in `sales` (#83 nulled All
-- Day's). Ops-only. p_days clamped 1–60.
-- Revert: DROP FUNCTION public.fmv_sales_backtest(text, integer);

CREATE OR REPLACE FUNCTION public.fmv_sales_backtest(p_collection text, p_days integer DEFAULT 7)
RETURNS TABLE (
  estimator text,
  confidence text,
  n bigint,
  median_abs_err_pct numeric,
  within_25_pct numeric,
  median_ratio numeric,
  median_abs_err_usd numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
WITH s AS (
  SELECT s.edition_id, s.price_usd AS p, s.sold_at AS t
  FROM public.sales s
  WHERE s.collection = p_collection
    AND s.sold_at > now() - make_interval(days => GREATEST(1, LEAST(COALESCE(p_days, 7), 60)))
    AND s.price_usd > 0 AND s.edition_id IS NOT NULL
    AND COALESCE(s.serial_number, 999999) > 25
    AND NOT (p_collection = 'nba_top_shot' AND COALESCE(lower(s.buyer_address), '') = '0xe1f2a091f7bb5245')
), j AS (
  SELECT s.p, f.fmv_usd AS published, f.confidence::text AS conf, l.last3
  FROM s
  CROSS JOIN LATERAL (
    SELECT x.fmv_usd, x.confidence FROM public.fmv_snapshots x
    WHERE x.edition_id = s.edition_id AND x.computed_at < s.t - interval '1 day'
    ORDER BY x.computed_at DESC LIMIT 1) f
  CROSS JOIN LATERAL (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY q.price_usd) AS last3
    FROM (SELECT y.price_usd FROM public.sales y
          WHERE y.edition_id = s.edition_id
            AND y.sold_at < s.t - interval '1 day' AND y.sold_at > s.t - interval '31 days'
            AND y.price_usd > 0 AND COALESCE(y.serial_number, 999999) > 25
            AND NOT (p_collection = 'nba_top_shot' AND COALESCE(lower(y.buyer_address), '') = '0xe1f2a091f7bb5245')
          ORDER BY y.sold_at DESC LIMIT 3) q) l
  WHERE f.fmv_usd > 0
), long AS (
  SELECT 'published'::text AS estimator, conf AS confidence, published AS est, p FROM j
  UNION ALL
  SELECT 'last3_median_30d', conf, last3, p FROM j WHERE last3 IS NOT NULL
)
SELECT estimator,
       COALESCE(confidence, 'ALL') AS confidence,
       count(*) AS n,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(est / p - 1)))::numeric * 100, 1) AS median_abs_err_pct,
       round(100.0 * avg(CASE WHEN abs(est / p - 1) <= 0.25 THEN 1 ELSE 0 END), 1) AS within_25_pct,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY est / p))::numeric, 3) AS median_ratio,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(est - p)))::numeric, 2) AS median_abs_err_usd
FROM long
GROUP BY estimator, ROLLUP(confidence)
ORDER BY estimator, confidence;
$function$;

-- anon-exec: NOT granted — ops instruments over the whole sales ledger; service_role / postgres only.
REVOKE ALL ON FUNCTION public.fmv_sales_backtest(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fmv_sales_backtest(text, integer) TO postgres, service_role;

DO $verify$
BEGIN
  IF has_function_privilege('anon', 'public.fmv_sales_backtest(text, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fmv_sales_backtest(text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fmv_sales_backtest must not be executable by anon / authenticated';
  END IF;
END
$verify$;
