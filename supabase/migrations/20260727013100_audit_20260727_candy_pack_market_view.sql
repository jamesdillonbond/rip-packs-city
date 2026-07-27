-- Applied to prod via Supabase MCP on 2026-07-27 as
-- audit_20260727_candy_pack_market_view. Committed here for parity.
--
-- The Candy pack market in one row: supply, ask floor, realised sale prices, and
-- the two honest comparisons — retail ($10) and the existing pack-EV model.
--
-- Why this matters: the first pack sales captured (0.39-0.45 SOL ~ $30-34) sit
-- almost exactly on candy_pack_ev_model.typical_pull_ev_usd (~$34) and far below
-- actual_ev_usd (~$63, chase-inclusive mean) — the market pricing the MEDIAN
-- pack, not the mean.
--
-- Every EV figure is passed through from candy_pack_ev_model, never recomputed,
-- so there stays exactly one pack-EV implementation.
--
-- REVERT: DROP VIEW IF EXISTS public.candy_pack_market;

CREATE OR REPLACE VIEW public.candy_pack_market
WITH (security_invoker = on) AS
WITH packs AS (
  SELECT count(*)                                  AS pack_assets_indexed,
         count(*) FILTER (WHERE NOT is_burnt)      AS sealed_supply,
         count(*) FILTER (WHERE is_burnt)          AS opened_supply,
         count(DISTINCT owner) FILTER (WHERE NOT is_burnt) AS distinct_holders,
         max(pack_supply)                          AS declared_supply,
         max(last_seen_at)                         AS inventory_refreshed_at
    FROM public.candy_packs
),
asks AS (
  SELECT count(*)      AS active_asks,
         min(price_usd) AS floor_ask_usd,
         min(price_sol) AS floor_ask_sol
    FROM public.candy_pack_listings
   WHERE is_active AND (expiry IS NULL OR expiry > now())
),
sales AS (
  SELECT count(*)                                                        AS sales_all,
         count(*) FILTER (WHERE sold_at > now() - interval '24 hours')    AS sales_24h,
         count(*) FILTER (WHERE sold_at > now() - interval '7 days')      AS sales_7d,
         round(sum(price_usd) FILTER (WHERE sold_at > now() - interval '7 days'), 2) AS volume_7d_usd,
         round(avg(price_usd) FILTER (WHERE sold_at > now() - interval '7 days'), 2) AS avg_7d_usd,
         round((percentile_cont(0.5) WITHIN GROUP (ORDER BY price_usd)
                FILTER (WHERE sold_at > now() - interval '7 days'))::numeric, 2)     AS median_7d_usd,
         max(sold_at)                                                    AS last_sale_at,
         round((array_agg(price_usd ORDER BY sold_at DESC))[1], 2)       AS last_sale_usd
    FROM public.candy_pack_sales
)
SELECT
  p.pack_assets_indexed,
  p.declared_supply,
  p.sealed_supply,
  p.opened_supply,
  p.distinct_holders,
  p.inventory_refreshed_at,
  a.active_asks,
  a.floor_ask_usd,
  a.floor_ask_sol,
  s.sales_all,
  s.sales_24h,
  s.sales_7d,
  s.volume_7d_usd,
  s.avg_7d_usd,
  s.median_7d_usd,
  s.last_sale_at,
  s.last_sale_usd,
  ev.pack_cost_usd                                                        AS retail_usd,
  ev.typical_pull_ev_usd,
  ev.actual_ev_usd,
  round(s.median_7d_usd / NULLIF(ev.pack_cost_usd, 0), 2)                 AS median_vs_retail_x,
  round(s.median_7d_usd / NULLIF(ev.typical_pull_ev_usd, 0), 2)           AS median_vs_typical_pull_x,
  round(s.median_7d_usd / NULLIF(ev.actual_ev_usd, 0), 2)                 AS median_vs_actual_ev_x,
  ev.model_note
FROM packs p
CROSS JOIN asks a
CROSS JOIN sales s
LEFT JOIN LATERAL (SELECT * FROM public.candy_pack_ev_model) ev ON true;

REVOKE ALL ON public.candy_pack_market FROM anon, authenticated;
COMMENT ON VIEW public.candy_pack_market IS
  'One-row Candy sealed-pack market summary: supply, ask floor, realised sales, and premium vs retail / typical-pull EV / actual EV. Pack prices NEVER feed fmv_snapshots. Added 2026-07-27.';
