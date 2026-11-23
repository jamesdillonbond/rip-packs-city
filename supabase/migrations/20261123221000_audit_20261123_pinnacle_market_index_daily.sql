-- audit_20261123: The RPC Index for Disney Pinnacle — pinnacle_market_index_daily (2026-11-23, Pinnacle parity
-- pass 3; Trevor: "Do it all"). The Pinnacle leg of /insights/market and /insights/allday-market, served at
-- /insights/pinnacle-market through the same MarketIndexClient (lib/insights/market-index-collections.ts).
--
-- Same columns and grain as allday_market_index_daily (d, tier, sales, volume_usd, median_px, avg_px, max_px; an
-- 'ALL' row per day), from pinnacle_sales on the render grain (pinnacle_catalog by render_id — never
-- pinnacle_editions, which is set-level). Tiers are Pinnacle's EDITION TYPE, the only rarity axis it has:
--   LEGENDARY = Legendary Edition + Genesis Edition (the 1/1–25 grails; 92 sales in 120 d on 11-23)
--   LIMITED   = Limited Edition + Limited Event Edition (4,198 sales)
--   OPEN      = Open Edition + Open Event Edition + Starter Edition (27,091 sales)
--   UNKNOWN   = a sale whose render the catalog lacks (kept, never dropped — it is in 'ALL').
-- Real sales only (price > 0), trailing 120 days, no zero-fill.
--
-- A plain VIEW, not a materialized one: measured 11-23 at 286 ms cold / 1,358 buffers (index-only scan on
-- idx_pinnacle_sales_render_rollup + a 2,985-row catalog hash), so no refresh job is added (the 11-22 lane budget).
-- security_invoker = on; read only by the service-role board read and /api/public/insights/market.
--
-- Revert: DROP VIEW public.pinnacle_market_index_daily;

CREATE OR REPLACE VIEW public.pinnacle_market_index_daily WITH (security_invoker = on) AS
WITH s AS (
  SELECT ps.sold_at::date AS d,
         CASE WHEN pc.edition_type IN ('Legendary Edition', 'Genesis Edition') THEN 'LEGENDARY'
              WHEN pc.edition_type IN ('Limited Edition', 'Limited Event Edition') THEN 'LIMITED'
              WHEN pc.edition_type IN ('Open Edition', 'Open Event Edition', 'Starter Edition') THEN 'OPEN'
              ELSE 'UNKNOWN' END AS tier,
         ps.sale_price_usd AS price_usd
    FROM public.pinnacle_sales ps
    LEFT JOIN public.pinnacle_catalog pc ON pc.render_id = ps.render_id
   WHERE ps.sold_at >= (CURRENT_DATE - 120)
     AND ps.sale_price_usd > 0
)
SELECT s.d, s.tier,
       count(*)::integer AS sales,
       round(sum(s.price_usd), 2) AS volume_usd,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd::double precision))::numeric, 2) AS median_px,
       round(avg(s.price_usd), 2) AS avg_px,
       round(max(s.price_usd), 2) AS max_px
  FROM s
 GROUP BY s.d, s.tier
UNION ALL
SELECT s.d, 'ALL'::text AS tier,
       count(*)::integer AS sales,
       round(sum(s.price_usd), 2) AS volume_usd,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd::double precision))::numeric, 2) AS median_px,
       round(avg(s.price_usd), 2) AS avg_px,
       round(max(s.price_usd), 2) AS max_px
  FROM s
 GROUP BY s.d;

REVOKE ALL ON TABLE public.pinnacle_market_index_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.pinnacle_market_index_daily TO service_role;

COMMENT ON VIEW public.pinnacle_market_index_daily IS
  'The RPC Index for Disney Pinnacle (2026-11-23): daily sales / volume / median / avg / max per edition-type tier (LEGENDARY = Legendary+Genesis, LIMITED = Limited+Limited Event, OPEN = Open+Open Event+Starter, UNKNOWN = uncatalogued render) plus ALL, trailing 120 days, real sales only. Same shape as allday_market_index_daily.';
