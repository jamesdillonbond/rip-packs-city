-- Item A2 — Candy deals + offer-spread boards, and floor-ask on the market board.
-- All read candy_listings/candy_listing_floor (Item A) — so they show 0/thin rows
-- until the first real ask prints (honest by construction). Gated; anon REVOKED.
-- Applied live via MCP; repo/rebuild parity.
-- Revert: DROP VIEW public.candy_deals_board, public.candy_offer_spread_board;
--         + recreate candy_secondary_board without floor_ask_usd/listing_count
--           from migration 20260724150000.
CREATE OR REPLACE VIEW public.candy_deals_board
WITH (security_invoker = true) AS
SELECT
  l.pda_address,
  l.token_mint,
  e.external_id,
  e.player_name,
  e.name                                   AS edition_name,
  e.tier::text                             AS tier,
  (e.tier = 'LEGENDARY')                   AS is_rainbow,
  e.circulation_count,
  w.serial_number,
  l.price_usd                              AS ask_usd,
  l.price_sol                              AS ask_sol,
  fc.fmv_usd,
  fc.confidence::text                      AS confidence,
  round(100.0 * (1 - l.price_usd / NULLIF(fc.fmv_usd, 0)), 1) AS discount_pct,
  l.seller,
  l.last_seen_at
FROM public.candy_listings l
JOIN public.editions e     ON e.id = l.edition_id
JOIN public.fmv_current fc ON fc.edition_id = l.edition_id
LEFT JOIN public.wallet_moments_cache w
  ON w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
 AND w.moment_id = l.token_mint
WHERE l.is_active
  AND l.price_usd IS NOT NULL AND l.price_usd > 0
  AND fc.fmv_usd  IS NOT NULL AND fc.fmv_usd  > 0
  AND l.price_usd < fc.fmv_usd;
REVOKE ALL ON public.candy_deals_board FROM anon, authenticated;
GRANT SELECT ON public.candy_deals_board TO service_role;

CREATE OR REPLACE VIEW public.candy_offer_spread_board
WITH (security_invoker = true) AS
SELECT
  e.external_id,
  e.player_name,
  e.name                                   AS edition_name,
  e.tier::text                             AS tier,
  (e.tier = 'LEGENDARY')                   AS is_rainbow,
  e.circulation_count,
  lf.floor_usd,
  lf.listing_count,
  bo.best_offer_usd,
  bo.distinct_bidders,
  fc.fmv_usd,
  CASE WHEN lf.floor_usd IS NOT NULL AND bo.best_offer_usd IS NOT NULL
       THEN round(lf.floor_usd - bo.best_offer_usd, 2) END AS spread_usd,
  CASE WHEN lf.floor_usd IS NOT NULL AND bo.best_offer_usd IS NOT NULL AND bo.best_offer_usd > 0
       THEN round(100.0 * (lf.floor_usd - bo.best_offer_usd) / bo.best_offer_usd, 1) END AS spread_pct
FROM public.editions e
LEFT JOIN public.candy_listing_floor lf ON lf.edition_id = e.id
LEFT JOIN public.candy_best_offers bo    ON bo.edition_id = e.id
LEFT JOIN public.fmv_current fc          ON fc.edition_id = e.id
WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
  AND (lf.floor_usd IS NOT NULL OR bo.best_offer_usd IS NOT NULL);
REVOKE ALL ON public.candy_offer_spread_board FROM anon, authenticated;
GRANT SELECT ON public.candy_offer_spread_board TO service_role;

CREATE OR REPLACE VIEW public.candy_secondary_board
WITH (security_invoker = true) AS
WITH cand AS (
  SELECT e.id, e.external_id, e.name AS edition_name, e.player_name, e.tier, e.circulation_count
  FROM public.editions e
  WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
),
sale_stats AS (
  SELECT s.edition_id,
         count(*) AS sales_all,
         count(*) FILTER (WHERE s.sold_at > now() - interval '24 hours') AS sales_24h,
         count(*) FILTER (WHERE s.sold_at > now() - interval '7 days')  AS sales_7d,
         max(s.sold_at) AS last_sale_at,
         (array_agg(s.price_usd ORDER BY s.sold_at DESC))[1] AS last_sale_usd
  FROM public.sales s
  WHERE s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid AND s.edition_id IS NOT NULL
  GROUP BY s.edition_id
)
SELECT
  c.external_id,
  c.player_name,
  c.edition_name,
  c.tier::text                              AS tier,
  (c.tier = 'LEGENDARY')                    AS is_rainbow,
  c.circulation_count,
  fc.fmv_usd,
  fc.confidence::text                       AS confidence,
  fc.computed_at                            AS fmv_computed_at,
  COALESCE(ss.sales_24h, 0)                 AS sales_24h,
  COALESCE(ss.sales_7d, 0)                  AS sales_7d,
  COALESCE(ss.sales_all, 0)                 AS sales_all,
  ss.last_sale_at,
  ss.last_sale_usd,
  bo.best_offer_usd,
  bo.distinct_bidders                       AS offer_bidders,
  lf.floor_usd                              AS floor_ask_usd,
  lf.listing_count
FROM cand c
LEFT JOIN public.fmv_current fc       ON fc.edition_id = c.id
LEFT JOIN sale_stats ss               ON ss.edition_id = c.id
LEFT JOIN public.candy_best_offers bo ON bo.edition_id = c.id
LEFT JOIN public.candy_listing_floor lf ON lf.edition_id = c.id;
REVOKE ALL ON public.candy_secondary_board FROM anon, authenticated;
GRANT SELECT ON public.candy_secondary_board TO service_role;
