-- audit_20260801_market_index_daily_materialize
--
-- CAUSE
--   /api/public/insights/market returned HTTP 500 "canceling statement due to
--   statement timeout", so /insights/market rendered "No market data in range."
--   even though the underlying data is healthy. The backing view
--   public.topshot_market_index_daily re-aggregates the FULL trailing 120 days
--   of Top Shot sales on EVERY read.
--
-- EVIDENCE (measured 2026-08-01, live)
--   SELECT count(*) FROM sales WHERE collection='nba_top_shot'
--     AND sold_at >= CURRENT_DATE-120 AND price_usd > 0;   -> 398,540
--   EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM topshot_market_index_daily:
--     Execution Time: 5,809 ms  WARM
--     Buffers: shared hit=310,895 read=13,643  (~2.5 GB touched)
--     temp read=3,461 written=3,469
--     Sort Method: external merge  Disk: 10,112 kB   (d, tier)
--     Sort Method: external merge  Disk:  7,504 kB   (d)
--   The same EXPLAIN ANALYZE COLD exceeded a 120 s statement_timeout outright.
--   Root cause is structural, not a bad plan: the CTE is referenced twice so it
--   is materialised to a temp spool and then sorted TWICE (percentile_cont is an
--   ordered-set aggregate, so neither group can be hash-aggregated), on top of a
--   ~400k-row index scan + heap fetch. 5.8 s warm is already past any request
--   budget; cold it is unbounded.
--
-- FIX
--   Materialise it. The data is daily-granularity and both readers already cache
--   for 15 minutes, so a snapshot is semantically identical to the live view.
--   public.topshot_market_index_daily keeps its name, column list, grants and
--   security_invoker=on and simply reads the snapshot, so every consumer
--   (app/api/public/insights/market/route.ts, app/insights/market/page.tsx)
--   is unchanged. Refresh is CONCURRENTLY (readers never block) on pg_cron
--   under cron_heavy, matching jobid 65's pattern.
--
-- REVERT SQL (exact)
--   SELECT cron.unschedule('rpc-refresh-market-index-daily');
--   CREATE OR REPLACE VIEW public.topshot_market_index_daily AS
--   WITH s AS (
--            SELECT s.sold_at::date AS d,
--               COALESCE(e.tier::text, 'UNKNOWN'::text) AS tier,
--               s.price_usd
--              FROM sales s JOIN editions e ON e.id = s.edition_id
--             WHERE s.collection = 'nba_top_shot'::text
--               AND s.sold_at >= (CURRENT_DATE - 120) AND s.price_usd > 0::numeric
--           )
--    SELECT s.d, s.tier, count(*)::integer AS sales,
--       round(sum(s.price_usd), 2) AS volume_usd,
--       round(percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (s.price_usd::double precision))::numeric, 2) AS median_px,
--       round(avg(s.price_usd), 2) AS avg_px,
--       round(max(s.price_usd), 2) AS max_px
--      FROM s GROUP BY s.d, s.tier
--   UNION ALL
--    SELECT s.d, 'ALL'::text AS tier, count(*)::integer AS sales,
--       round(sum(s.price_usd), 2) AS volume_usd,
--       round(percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (s.price_usd::double precision))::numeric, 2) AS median_px,
--       round(avg(s.price_usd), 2) AS avg_px,
--       round(max(s.price_usd), 2) AS max_px
--      FROM s GROUP BY s.d;
--   ALTER VIEW public.topshot_market_index_daily SET (security_invoker = on);
--   GRANT SELECT ON public.topshot_market_index_daily TO anon, authenticated, service_role;
--   DROP MATERIALIZED VIEW IF EXISTS public.mv_topshot_market_index_daily;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_topshot_market_index_daily AS
WITH s AS (
         SELECT s.sold_at::date AS d,
            COALESCE(e.tier::text, 'UNKNOWN'::text) AS tier,
            s.price_usd
           FROM sales s
             JOIN editions e ON e.id = s.edition_id
          WHERE s.collection = 'nba_top_shot'::text
            AND s.sold_at >= (CURRENT_DATE - 120)
            AND s.price_usd > 0::numeric
        )
 SELECT s.d,
    s.tier,
    count(*)::integer AS sales,
    round(sum(s.price_usd), 2) AS volume_usd,
    round(percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (s.price_usd::double precision))::numeric, 2) AS median_px,
    round(avg(s.price_usd), 2) AS avg_px,
    round(max(s.price_usd), 2) AS max_px
   FROM s
  GROUP BY s.d, s.tier
UNION ALL
 SELECT s.d,
    'ALL'::text AS tier,
    count(*)::integer AS sales,
    round(sum(s.price_usd), 2) AS volume_usd,
    round(percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (s.price_usd::double precision))::numeric, 2) AS median_px,
    round(avg(s.price_usd), 2) AS avg_px,
    round(max(s.price_usd), 2) AS max_px
   FROM s
  GROUP BY s.d
WITH NO DATA;

-- Required for REFRESH ... CONCURRENTLY, and serves the route's `d >= cutoff`
-- filter + `ORDER BY d, tier` directly.
CREATE UNIQUE INDEX IF NOT EXISTS mv_topshot_market_index_daily_d_tier_key
  ON public.mv_topshot_market_index_daily (d, tier);

COMMENT ON MATERIALIZED VIEW public.mv_topshot_market_index_daily IS
  'Snapshot of the tier-segmented trailing-120d Top Shot market index. Refreshed CONCURRENTLY hourly by pg_cron job rpc-refresh-market-index-daily. Read through the view public.topshot_market_index_daily, never directly. See audit_20260801_market_index_daily_materialize.';

-- The view is security_invoker=on and granted to anon, so the invoker needs
-- SELECT on the snapshot too. Same public aggregate data the view already
-- exposed; no new information is reachable.
GRANT SELECT ON public.mv_topshot_market_index_daily TO anon, authenticated, service_role;
