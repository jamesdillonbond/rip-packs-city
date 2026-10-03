-- audit_20261003_topshot_fmv_backtest
--
-- Makes Top Shot FMV accuracy MEASURABLE out of sample — the platform's gate
-- metric — the way panini_fmv_backtest (20260924045351) did for Panini. Until
-- now Top Shot accuracy was read only as a CONFIDENCE SHARE (M1), which is a
-- property of the population sampled, not of the price.
--
-- Each realized sale (non-special serial > 25, not a Dapper sell-back to
-- 0xe1f2a091f7bb5245, price > 0) is compared with (a) the FMV we had PUBLISHED
-- more than a day before it (latest fmv_snapshots row before sold_at - 1 day)
-- and (b) a naive comparator: the median of the edition's last 3 prior sales in
-- the 30 days before that same cut-off. Both are out of sample with respect to
-- the target sale.
--
-- Measured 2026-10-03 ~3:45 PM PT (PT weeks, sales 1-day-prior FMV):
--   week 0 (last 7 d, n=17,134): published median abs err 14.3 %, ratio 1.000;
--                                 last-3 median 12.5 %, 1.000
--   week 1: 15.0 % / 1.045 vs 13.0 % / 1.000
--   week 2: 17.6 % / 1.100 vs 13.0 % / 1.000
--   week 3: 24.8 % / 1.200 vs 17.5 % / 1.100
--   week 4: 20.0 % / 1.136 vs 15.0 % / 1.042
--   By confidence, last 7 d: HIGH 10.0 % / 84.0 % within ±25 % / 1.000;
--   MEDIUM 15.0 % / 68.1 % / 1.043; LOW 21.8 % / 57.2 %; ASK_ONLY 54.9 % / 1.549.
-- Reading: the confidence tiers ORDER correctly (unlike Panini's), but the
-- published FMV trails the naive last-3 median by 2–7 pts every week and ran
-- HIGH (ratio 1.05–1.20) in the four weeks before this one. Whether that is the
-- ask blend or lag in a falling market is NOT settled here — this function is
-- the instrument to settle it with, re-run on demand.
--
-- Ops-only (service_role / postgres). One row per estimator × confidence plus
-- an "ALL" rollup. p_days bounds the cost: 7 d ≈ 17k sales, 2 index probes each.
-- Revert: DROP FUNCTION public.topshot_fmv_backtest(integer);

CREATE OR REPLACE FUNCTION public.topshot_fmv_backtest(p_days integer DEFAULT 7)
RETURNS TABLE (
  estimator text,
  confidence text,
  n bigint,
  median_abs_err_pct numeric,
  within_25_pct numeric,
  median_ratio numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
WITH s AS (
  SELECT s.edition_id, s.price_usd AS p, s.sold_at AS t
  FROM public.sales s
  WHERE s.collection = 'nba_top_shot'
    AND s.sold_at > now() - make_interval(days => GREATEST(1, LEAST(COALESCE(p_days, 7), 60)))
    AND s.price_usd > 0 AND s.edition_id IS NOT NULL
    AND COALESCE(s.serial_number, 999999) > 25
    AND COALESCE(lower(s.buyer_address), '') <> '0xe1f2a091f7bb5245'
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
            AND COALESCE(lower(y.buyer_address), '') <> '0xe1f2a091f7bb5245'
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
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY est / p))::numeric, 3) AS median_ratio
FROM long
GROUP BY estimator, ROLLUP(confidence)
ORDER BY estimator, confidence;
$function$;

-- anon-exec: NOT granted — an ops instrument over the whole sales ledger; service_role / postgres only.
REVOKE ALL ON FUNCTION public.topshot_fmv_backtest(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_fmv_backtest(integer) TO postgres, service_role;

DO $verify$
BEGIN
  IF has_function_privilege('anon', 'public.topshot_fmv_backtest(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute topshot_fmv_backtest';
  END IF;
  IF has_function_privilege('authenticated', 'public.topshot_fmv_backtest(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can execute topshot_fmv_backtest';
  END IF;
END
$verify$;
