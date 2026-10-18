-- 2026-10-18 (Claude Code cloud) — #193's measurement as a standing, re-readable function.
--
-- WHY: fmv_sales_backtest reads fmv_snapshots, which holds NO Pinnacle rows, so Pinnacle FMV had no
-- realised-sales instrument until a one-off query on 10-17 (#193). #193's ship gate ("re-measure at
-- >= 500 post-10-09 HIGH sales; ship last-5 only if it still wins within-±25 % AND WAPE on HIGH without
-- losing MEDIUM") needs that measurement to be re-readable, not re-written from prose.
--
-- METHOD (verbatim from #193): each pinnacle_sales sale (render-keyed, price > 0) in [p_since, p_until)
-- against the pinnacle_fmv_history value in force >= 1 day before it (history writes only on change,
-- so the value in force may sit in an older row), and against the median of that render's last 5 sales
-- >= 1 day before it. Only PAIRED sales count (both a published value > 0 and >= 1 prior sale). Read
-- within ±25 % and dollar-weighted error (WAPE), not MdAPE: medians tie on repeated price points.
--
-- REPRODUCES 10-17 on the same window (sold_at 10-11 00:00 PT → 10-17 7:30 PM PT): HIGH n 163,
-- within ±25 % 68.1 vs naive-5 74.2, WAPE 31.7 vs 22.9 — identical to #193.
--
-- Gate read: SELECT * FROM pinnacle_fmv_sales_backtest('2026-10-09 14:00-07');  -- HIGH n >= 500?
-- n_full5 counts pairs whose naive median had all 5 prior sales.
--
-- anon-exec: revoked (pinnacle_fmv_sales_backtest) — new function; REVOKE FROM PUBLIC, anon, authenticated below.

CREATE FUNCTION public.pinnacle_fmv_sales_backtest(p_since timestamptz, p_until timestamptz DEFAULT now())
RETURNS TABLE(confidence text, n bigint, n_full5 bigint,
              published_within25_pct numeric, naive5_within25_pct numeric,
              published_wape_pct numeric, naive5_wape_pct numeric)
LANGUAGE sql
STABLE
SET search_path = public
AS $function$
  WITH s AS (
    SELECT ps.render_id, ps.sale_price_usd::numeric AS price, ps.sold_at
      FROM pinnacle_sales ps
     WHERE ps.render_id IS NOT NULL AND ps.sale_price_usd > 0
       AND ps.sold_at >= p_since AND ps.sold_at < p_until
  ), j AS (
    SELECT s.price, h.fmv_usd AS pub, h.fmv_confidence AS conf, n5.med5, n5.k
      FROM s
      CROSS JOIN LATERAL (SELECT fh.fmv_usd, fh.fmv_confidence
                            FROM pinnacle_fmv_history fh
                           WHERE fh.render_id = s.render_id
                             AND fh.computed_at <= s.sold_at - interval '1 day'
                           ORDER BY fh.computed_at DESC
                           LIMIT 1) h
      CROSS JOIN LATERAL (SELECT (percentile_cont(0.5) WITHIN GROUP (ORDER BY x.p))::numeric AS med5,
                                 count(*) AS k
                            FROM (SELECT p2.sale_price_usd::numeric AS p
                                    FROM pinnacle_sales p2
                                   WHERE p2.render_id = s.render_id AND p2.sale_price_usd > 0
                                     AND p2.sold_at <= s.sold_at - interval '1 day'
                                   ORDER BY p2.sold_at DESC
                                   LIMIT 5) x) n5
     WHERE h.fmv_usd > 0 AND n5.k >= 1
  )
  SELECT COALESCE(j.conf, 'ALL') AS confidence,
         count(*) AS n,
         count(*) FILTER (WHERE j.k = 5) AS n_full5,
         round(100.0 * avg((abs(j.pub - j.price) / j.price <= 0.25)::int), 1),
         round(100.0 * avg((abs(j.med5 - j.price) / j.price <= 0.25)::int), 1),
         round(100.0 * sum(abs(j.pub - j.price)) / sum(j.price), 1),
         round(100.0 * sum(abs(j.med5 - j.price)) / sum(j.price), 1)
    FROM j
   GROUP BY ROLLUP (j.conf)
   ORDER BY (j.conf IS NULL), j.conf;
$function$;

REVOKE EXECUTE ON FUNCTION public.pinnacle_fmv_sales_backtest(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pinnacle_fmv_sales_backtest(timestamptz, timestamptz) TO service_role;

COMMENT ON FUNCTION public.pinnacle_fmv_sales_backtest(timestamptz, timestamptz) IS
  '#193 instrument: Pinnacle published FMV (value in force >= 1 d before) vs naive median of last 5 sales, per confidence tier + ALL. Paired sales only.';
