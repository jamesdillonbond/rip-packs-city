-- audit_20260801_market_index_daily_view_reads_snapshot
--
-- CAUSE / EVIDENCE: see audit_20260801_market_index_daily_materialize (the
-- 5.8s-warm / >120s-cold recompute). Confirmed root cause of the HTTP 500:
-- the route reads via supabaseAdmin, and role service_role carries
-- statement_timeout=30s (pg_roles.rolconfig), so a cold read of the live view
-- was cancelled -> "canceling statement due to statement timeout" -> the page
-- rendered "No market data in range."
--
-- This is step 2: point the public view at the snapshot that migration created
-- and populated (687 rows, 121 days x 7 tiers, 2026-04-03..2026-08-01, ALL-tier
-- sales 398,561), and schedule the hourly refresh. The view keeps its NAME,
-- COLUMN LIST, security_invoker=on and grants, so both consumers
-- (app/api/public/insights/market/route.ts, app/insights/market/page.tsx) are
-- unchanged. CREATE OR REPLACE VIEW wipes reloptions, hence the explicit
-- ALTER ... SET (security_invoker = on).
--
-- Job runs as `postgres` (no statement_timeout override), matching the two
-- sibling MV-refresh jobs 40/41. Cost ~6-12 s once an hour.
--
-- REVERT SQL (exact) — restores the live-aggregating view and drops the job:
--   SELECT cron.unschedule('rpc-refresh-market-index-daily');
--   CREATE OR REPLACE VIEW public.topshot_market_index_daily AS
--   WITH s AS (
--            SELECT s.sold_at::date AS d,
--               COALESCE(e.tier::text, 'UNKNOWN'::text) AS tier, s.price_usd
--              FROM sales s JOIN editions e ON e.id = s.edition_id
--             WHERE s.collection = 'nba_top_shot'::text
--               AND s.sold_at >= (CURRENT_DATE - 120) AND s.price_usd > 0::numeric)
--    SELECT s.d, s.tier, count(*)::integer AS sales,
--       round(sum(s.price_usd), 2) AS volume_usd,
--       round(percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (s.price_usd::double precision))::numeric, 2) AS median_px,
--       round(avg(s.price_usd), 2) AS avg_px, round(max(s.price_usd), 2) AS max_px
--      FROM s GROUP BY s.d, s.tier
--   UNION ALL
--    SELECT s.d, 'ALL'::text, count(*)::integer,
--       round(sum(s.price_usd), 2),
--       round(percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (s.price_usd::double precision))::numeric, 2),
--       round(avg(s.price_usd), 2), round(max(s.price_usd), 2)
--      FROM s GROUP BY s.d;
--   ALTER VIEW public.topshot_market_index_daily SET (security_invoker = on);
--   GRANT SELECT ON public.topshot_market_index_daily TO anon, authenticated, service_role;
--   DROP MATERIALIZED VIEW IF EXISTS public.mv_topshot_market_index_daily;

CREATE OR REPLACE VIEW public.topshot_market_index_daily AS
SELECT d, tier, sales, volume_usd, median_px, avg_px, max_px
  FROM public.mv_topshot_market_index_daily;

ALTER VIEW public.topshot_market_index_daily SET (security_invoker = on);
GRANT SELECT ON public.topshot_market_index_daily TO anon, authenticated, service_role;

COMMENT ON VIEW public.topshot_market_index_daily IS
  'Tier-segmented trailing-120d Top Shot market index. Reads the hourly snapshot mv_topshot_market_index_daily (audit_20260801_market_index_daily_materialize) — recomputing live cost 5.8s warm / >120s cold and 500-ed the public route under the service_role 30s statement_timeout.';

SELECT cron.schedule(
  'rpc-refresh-market-index-daily',
  '7 * * * *',
  'REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_market_index_daily'
);
