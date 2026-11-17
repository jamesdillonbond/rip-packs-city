-- audit_20261009_fmv_backtests_exclude_every_registered_buyback_wallet
--
-- The two accuracy-gate yardsticks, fmv_sales_backtest(collection, days) and topshot_fmv_backtest(days),
-- each HARDCODED one buy-back wallet (Top Shot's 0xe1f2a091f7bb5245) in two predicates. The registry
-- they were meant to mirror, public.buyback_wallets, has held three wallets since 10-01:
-- 0xe1f2... (TopShot_Buyback_2), 0x4d2c9216f1dca098 (NBATopShotCommunity) and the All Day issuer
-- 0xe4cf4bdc1751c65d (pack buy-backs, register #161). So the All Day backtest counted issuer buy-backs
-- as collector sales, and the Top Shot ones counted the community wallet's: the hardcoded allowlist
-- beside a registry that CLAUDE.md warns goes stale silently. Measured 10-09 ~2:35 PM PT: 0 such
-- sales in the last 7 d for either collection, so today's readings (TS 12.0 % / AD 21.6 % median abs
-- error) are unaffected. This closes the latent gap before a buy-back burst can move the gate.
--
-- Change: both read public.sales_market (sales minus buyers in buyback_wallets for that collection;
-- NULL buyers kept), and the hardcoded predicates are gone. The rest of each body is the committed one
-- verbatim (20261003224946 / 20261003223807; live prosrc md5 53da2bb0... / efefa2a0... = those files,
-- read 10-09). SECURITY INVOKER is unchanged: the callers are service_role / postgres, exactly the roles
-- that can read sales_market and its RLS-protected registry. The guard's two suppressions for these
-- functions are removed in the same commit (__tests__/fmv-writers-read-sales-market-not-sales.test.ts),
-- so a future revert to raw `sales` reds CI.
--
-- REVERT: re-apply the two CREATE statements of 20261003224946 and 20261003223807, and restore the two
-- SUPPRESSED entries in the guard.

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
  FROM public.sales_market s
  WHERE s.collection = p_collection
    AND s.sold_at > now() - make_interval(days => GREATEST(1, LEAST(COALESCE(p_days, 7), 60)))
    AND s.price_usd > 0 AND s.edition_id IS NOT NULL
    AND COALESCE(s.serial_number, 999999) > 25
), j AS (
  SELECT s.p, f.fmv_usd AS published, f.confidence::text AS conf, l.last3
  FROM s
  CROSS JOIN LATERAL (
    SELECT x.fmv_usd, x.confidence FROM public.fmv_snapshots x
    WHERE x.edition_id = s.edition_id AND x.computed_at < s.t - interval '1 day'
    ORDER BY x.computed_at DESC LIMIT 1) f
  CROSS JOIN LATERAL (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY q.price_usd) AS last3
    FROM (SELECT y.price_usd FROM public.sales_market y
          WHERE y.edition_id = s.edition_id
            AND y.sold_at < s.t - interval '1 day' AND y.sold_at > s.t - interval '31 days'
            AND y.price_usd > 0 AND COALESCE(y.serial_number, 999999) > 25
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
  FROM public.sales_market s
  WHERE s.collection = 'nba_top_shot'
    AND s.sold_at > now() - make_interval(days => GREATEST(1, LEAST(COALESCE(p_days, 7), 60)))
    AND s.price_usd > 0 AND s.edition_id IS NOT NULL
    AND COALESCE(s.serial_number, 999999) > 25
), j AS (
  SELECT s.p, f.fmv_usd AS published, f.confidence::text AS conf, l.last3
  FROM s
  CROSS JOIN LATERAL (
    SELECT x.fmv_usd, x.confidence FROM public.fmv_snapshots x
    WHERE x.edition_id = s.edition_id AND x.computed_at < s.t - interval '1 day'
    ORDER BY x.computed_at DESC LIMIT 1) f
  CROSS JOIN LATERAL (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY q.price_usd) AS last3
    FROM (SELECT y.price_usd FROM public.sales_market y
          WHERE y.edition_id = s.edition_id
            AND y.sold_at < s.t - interval '1 day' AND y.sold_at > s.t - interval '31 days'
            AND y.price_usd > 0 AND COALESCE(y.serial_number, 999999) > 25
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

-- anon-exec: NOT granted — ops instruments over the whole sales ledger; service_role / postgres only.
REVOKE ALL ON FUNCTION public.fmv_sales_backtest(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fmv_sales_backtest(text, integer) TO postgres, service_role;
REVOKE ALL ON FUNCTION public.topshot_fmv_backtest(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_fmv_backtest(integer) TO postgres, service_role;

DO $verify$
BEGIN
  IF has_function_privilege('anon', 'public.fmv_sales_backtest(text, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.topshot_fmv_backtest(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a backtest is anon-executable';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE proname IN ('fmv_sales_backtest','topshot_fmv_backtest')
        AND prosrc LIKE '%public.sales_market s%' AND prosrc LIKE '%public.sales_market y%'
        AND prosrc NOT LIKE '%0xe1f2%') <> 2 THEN
    RAISE EXCEPTION 'backtests do not both read sales_market';
  END IF;
END $verify$;
