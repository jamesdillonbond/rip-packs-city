-- Phase 6 — fix Pinnacle marketplace label in analytics_sales.
-- Previously the Pinnacle UNION branch passed `ps.source` as marketplace,
-- which surfaced as 'on-chain'. This labels every Pinnacle row as
-- 'pinnacle' to match the long→short marketplace dictionary the rest of
-- the analytics views use, and feeds the new Marketplace Breakdown card
-- on the Analytics page.

CREATE OR REPLACE VIEW public.analytics_sales AS
 SELECT s.id::text AS id,
        CASE s.collection
            WHEN 'nba_top_shot'::text THEN 'topshot'::text
            WHEN 'nfl_all_day'::text THEN 'allday'::text
            WHEN 'laliga_golazos'::text THEN 'golazos'::text
            WHEN 'ufc_strike'::text THEN 'ufc'::text
            ELSE s.collection
        END AS collection,
    s.edition_id::text AS edition_id,
    s.moment_id::text AS moment_id,
    s.serial_number,
    s.price_usd,
    s.price_native,
    s.currency::text AS currency,
    s.seller_address::text AS seller_address,
    s.buyer_address::text AS buyer_address,
    s.marketplace::text AS marketplace,
    s.transaction_hash::text AS transaction_hash,
    s.block_height,
    s.sold_at,
    s.nft_id::text AS nft_id,
    s.source
   FROM sales s
  WHERE s.sold_at >= '2025-01-01 00:00:00+00'::timestamp with time zone
UNION ALL
 SELECT ps.id,
    'pinnacle'::text AS collection,
    ps.edition_id,
    NULL::text AS moment_id,
    ps.serial_number,
    ps.sale_price_usd AS price_usd,
    NULL::numeric AS price_native,
    NULL::text AS currency,
    ps.seller_address,
    ps.buyer_address,
    'pinnacle'::text AS marketplace,
    NULL::text AS transaction_hash,
    NULL::bigint AS block_height,
    ps.sold_at,
    ps.nft_id,
    ps.source
   FROM pinnacle_sales ps;
