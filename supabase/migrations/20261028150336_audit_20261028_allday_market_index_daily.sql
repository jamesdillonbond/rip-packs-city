-- audit_20261028: NFL All Day market index (All Day ↔ Top Shot parity — /insights/allday-market).
--
-- Same shape as mv_topshot_market_index_daily / topshot_market_index_daily: real secondary sales (price_usd > 0) over
-- the trailing 120 days, per day × tier (+ an ALL row), sales / volume / median / avg / max. Measured 10-28 ~8:00 AM PT
-- over All Day: COMMON 362 sales/day, UNCOMMON 75, RARE 46 (all trade every day), LEGENDARY 2.7/day (99 of 120 days),
-- ULTIMATE 2 sales in 120 days — the page plots COMMON / UNCOMMON / RARE / LEGENDARY and states why ULTIMATE is out.
-- Cost: the aggregate reads ~55k buffers (all hits) in ~0.2 s, so it refreshes on its own pg_cron job (`9 */2 * * *`,
-- two minutes after Top Shot's `7 */2`), independent of Top Shot's so one failing never stalls the other.
-- Access: service_role only (the board's server page and API route read it with the service-role client); anon and
-- authenticated get nothing. The view is security_invoker. ⚠ While Dapper's marketplaces are in maintenance (since
-- 10-27 ~9:30 AM PT) the newest days carry no sales — the board shows the data's own last day, never today's.
-- anon-exec: n/a — creates no function.
--
-- Revert: SELECT cron.unschedule('rpc-refresh-allday-market-index-daily');
--         DROP VIEW public.allday_market_index_daily; DROP MATERIALIZED VIEW public.mv_allday_market_index_daily;

CREATE MATERIALIZED VIEW public.mv_allday_market_index_daily AS
 WITH s AS (
         SELECT (s.sold_at)::date AS d,
            COALESCE((e.tier)::text, 'UNKNOWN'::text) AS tier,
            s.price_usd
           FROM (sales s
             JOIN editions e ON ((e.id = s.edition_id)))
          WHERE ((s.collection = 'nfl_all_day'::text) AND (s.sold_at >= (CURRENT_DATE - 120)) AND (s.price_usd > (0)::numeric))
        )
 SELECT s.d,
    s.tier,
    (count(*))::integer AS sales,
    round(sum(s.price_usd), 2) AS volume_usd,
    round((percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((s.price_usd)::double precision)))::numeric, 2) AS median_px,
    round(avg(s.price_usd), 2) AS avg_px,
    round(max(s.price_usd), 2) AS max_px
   FROM s
  GROUP BY s.d, s.tier
UNION ALL
 SELECT s.d,
    'ALL'::text AS tier,
    (count(*))::integer AS sales,
    round(sum(s.price_usd), 2) AS volume_usd,
    round((percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((s.price_usd)::double precision)))::numeric, 2) AS median_px,
    round(avg(s.price_usd), 2) AS avg_px,
    round(max(s.price_usd), 2) AS max_px
   FROM s
  GROUP BY s.d;

CREATE UNIQUE INDEX mv_allday_market_index_daily_d_tier_key ON public.mv_allday_market_index_daily (d, tier);

CREATE VIEW public.allday_market_index_daily WITH (security_invoker = on) AS
 SELECT d, tier, sales, volume_usd, median_px, avg_px, max_px
   FROM public.mv_allday_market_index_daily;

REVOKE ALL ON public.mv_allday_market_index_daily FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.allday_market_index_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mv_allday_market_index_daily TO service_role;
GRANT SELECT ON public.allday_market_index_daily TO service_role;

SELECT cron.schedule(
  'rpc-refresh-allday-market-index-daily',
  '9 */2 * * *',
  $$SET statement_timeout = '600s'; REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_allday_market_index_daily;$$
);
