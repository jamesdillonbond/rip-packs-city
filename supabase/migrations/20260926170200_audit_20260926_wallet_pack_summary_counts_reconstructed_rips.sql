-- 2026-09-26 (PT) — get_wallet_pack_summary counts the packs a wallet opened
-- with NO pack NFT (wallet_reconstructed_rips, 20260926170000) in packs_ripped
-- and ripped_value, and publishes the share as packs_ripped_reconstructed so a
-- reader can tell a reconstruction from an open event. Sibling of 20260926170100.
-- anon-exec: unchanged (get_wallet_pack_summary) — CREATE OR REPLACE of an existing fn; ACL preserved, has_function_privilege anon=false, authenticated=false (read 2026-09-26).
--
-- Revert: re-apply the body from
--   supabase/migrations/20260926160100_audit_20260926_wallet_pack_summary_counts_golazos_pinnacle_opens_and_dapper_pull_values.sql
-- and repoint its pin in __tests__/db-invariants-drift-guard.test.ts.

CREATE OR REPLACE FUNCTION public.get_wallet_pack_summary(p_wallet text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '15s'
AS $function$
DECLARE
  v_wallet text := lower(coalesce(p_wallet, ''));
  v_ts uuid;
  v_ad uuid;
  v_gz uuid;
  v_pin uuid;
  v_purchases_total int; v_sales_total int; v_rips_total int;
  v_rips_valued int;
  v_rips_reconstructed int;
  v_spent numeric; v_proceeds numeric; v_ripped_value numeric;
  v_primary_spent numeric; v_primary_count int; v_primary_unknown int;
  v_secondary_spent numeric; v_secondary_count int;
  v_secondary_proceeds numeric; v_secondary_sold_count int;
  v_buys_marketplace int; v_sells_marketplace int;
  v_currency_breakdown jsonb; v_by_collection jsonb;
  v_first_event timestamptz; v_last_event timestamptz;
BEGIN
  IF v_wallet = '' THEN RETURN jsonb_build_object('error', 'wallet required'); END IF;

  SELECT id INTO v_ts FROM public.collections WHERE slug = 'nba_top_shot';
  SELECT id INTO v_ad FROM public.collections WHERE slug = 'nfl_all_day';
  SELECT id INTO v_gz FROM public.collections WHERE slug = 'laliga_golazos';
  SELECT id INTO v_pin FROM public.collections WHERE slug = 'disney_pinnacle';

  -- One row per (collection, pack) the wallet BOUGHT and one per pack it SOLD,
  -- across the on-chain table and the two marketplace-history tables, so a
  -- purchase both sources saw counts once. Materialised in temp tables because
  -- three aggregates below read each set. Dropped first so the function is
  -- safe to call twice inside one transaction (ON COMMIT DROP alone is not).
  DROP TABLE IF EXISTS _wps_buys; DROP TABLE IF EXISTS _wps_sells; DROP TABLE IF EXISTS _wps_rips;
  CREATE TEMP TABLE _wps_buys ON COMMIT DROP AS
  WITH buy_src AS (
    SELECT pp.pack_nft_id, pp.collection_id, pp.sale_price AS price, pp.sale_currency AS currency,
           pp.sealed_at AS at, pp.is_primary_drop, pp.pack_dist_id AS dist_id, 'onchain'::text AS src, 1 AS pri,
           -- 2026-09-25 (#134): custom_id 'nba' is Top Shot's own shop (one storefront,
           -- fixed price per dist), which the ingest worker labels secondary_sale. It is a
           -- PRIMARY buy, priced at what was paid (sale_price), not at retail.
           (pp.custom_id = 'nba' AND pp.collection_id = v_ts) AS is_shop
    FROM public.pack_purchases pp WHERE pp.buyer_address = v_wallet
    UNION ALL
    SELECT h.pack_nft_id, v_ts, h.sale_price_usd, 'USD', h.block_time, false, h.dist_id, 'marketplace', 2, false
    FROM public.topshot_pack_sales_history h WHERE h.buyer_address = v_wallet AND h.purchased
    UNION ALL
    SELECT h.pack_nft_id, v_ad, h.sale_price_usd, 'USD', h.block_time, false, h.dist_id, 'marketplace', 2, false
    FROM public.allday_pack_sales_history h WHERE h.buyer_address = v_wallet AND h.purchased
    UNION ALL
    -- 2026-09-26: Golazos marketplace history too.
    SELECT h.pack_nft_id, v_gz, h.sale_price_usd, 'USD', h.block_time, false, h.dist_id, 'marketplace', 2, false
    FROM public.golazos_pack_sales_history h WHERE h.buyer_address = v_wallet AND h.purchased
  ),
  latest AS (
    SELECT DISTINCT ON (collection_id, pack_nft_id) *
    FROM buy_src ORDER BY collection_id, pack_nft_id, at DESC, pri
  ),
  any_dist AS (
    SELECT collection_id, pack_nft_id, MAX(dist_id) AS dist_id
    FROM buy_src WHERE dist_id IS NOT NULL GROUP BY 1, 2
  )
  SELECT
    l.collection_id, l.pack_nft_id, l.price, l.currency, l.at,
    (l.is_primary_drop OR coalesce(l.is_shop, false)) AS is_primary_drop, l.src,
    CASE WHEN l.is_primary_drop THEN
      COALESCE(
        (pd_direct.metadata->>'retail_price_usd')::numeric,
        (pd_via_rip.metadata->>'retail_price_usd')::numeric
      )
    ELSE l.price END AS effective_buy_usd,
    (l.is_primary_drop AND
      COALESCE(
        (pd_direct.metadata->>'retail_price_usd')::numeric,
        (pd_via_rip.metadata->>'retail_price_usd')::numeric
      ) IS NULL
    ) AS is_unknown_primary_buy
  FROM latest l
  LEFT JOIN any_dist ad ON ad.collection_id = l.collection_id AND ad.pack_nft_id = l.pack_nft_id
  LEFT JOIN public.pack_distributions pd_direct
    ON pd_direct.dist_id = ad.dist_id AND pd_direct.collection_id = l.collection_id
  LEFT JOIN public.pack_rips pr
    ON pr.pack_nft_id = l.pack_nft_id AND pr.collection_id = l.collection_id
  LEFT JOIN public.pack_distributions pd_via_rip
    ON pd_via_rip.dist_id = pr.dist_id AND pd_via_rip.collection_id = l.collection_id;

  CREATE TEMP TABLE _wps_sells ON COMMIT DROP AS
  WITH sell_src AS (
    SELECT pp.pack_nft_id, pp.collection_id, pp.sale_price AS price, pp.sale_currency AS currency,
           pp.sealed_at AS at, pp.is_primary_drop, 'onchain'::text AS src, 1 AS pri
    FROM public.pack_purchases pp WHERE pp.seller_address = v_wallet
    UNION ALL
    SELECT h.pack_nft_id, v_ts, h.sale_price_usd, 'USD', h.block_time, false, 'marketplace', 2
    FROM public.topshot_pack_sales_history h WHERE h.storefront_address = v_wallet AND h.purchased
    UNION ALL
    SELECT h.pack_nft_id, v_ad, h.sale_price_usd, 'USD', h.block_time, false, 'marketplace', 2
    FROM public.allday_pack_sales_history h WHERE h.storefront_address = v_wallet AND h.purchased
    UNION ALL
    SELECT h.pack_nft_id, v_gz, h.sale_price_usd, 'USD', h.block_time, false, 'marketplace', 2
    FROM public.golazos_pack_sales_history h WHERE h.storefront_address = v_wallet AND h.purchased
  )
  SELECT DISTINCT ON (collection_id, pack_nft_id) *
  FROM sell_src ORDER BY collection_id, pack_nft_id, at DESC, pri;

  -- 2026-09-26: every pack the wallet OPENED -- Top Shot + All Day rips and the
  -- Golazos / Pinnacle open tables (pack_rips holds neither) -- valued from
  -- Dapper's list of the moments each pack yielded (pack_open_pull_values, same
  -- opener) first, the open row's own value otherwise. NULL stays NULL.
  CREATE TEMP TABLE _wps_rips ON COMMIT DROP AS
  SELECT o.collection_id, o.pack_nft_id, o.sealed_at, o.reconstructed,
         COALESCE(pov.pull_value_usd, o.pull_value_usd) AS pull_value_usd
  FROM (
    SELECT collection_id, pack_nft_id, sealed_at, pull_value_usd, false AS reconstructed
    FROM public.pack_rips WHERE opener_address = v_wallet
    UNION ALL
    SELECT v_gz, pack_nft_id, opened_at, pull_value_usd, false
    FROM public.golazos_pack_opens WHERE opener_address = v_wallet
    UNION ALL
    SELECT v_pin, pack_nft_id, opened_at, pull_value_usd, false
    FROM public.pinnacle_pack_opens WHERE opener_address = v_wallet
    UNION ALL
    -- 2026-09-26: packs opened with no pack NFT, reconstructed from delivery
    -- bursts (wallet_reconstructed_rips); counted, and counted separately.
    SELECT collection_id, burst_id, opened_at, pull_value_usd, true
    FROM public.wallet_reconstructed_rips WHERE wallet = v_wallet
  ) o
  LEFT JOIN public.pack_open_pull_values pov
    ON pov.collection_id = o.collection_id AND pov.pack_nft_id = o.pack_nft_id AND pov.opener_address = v_wallet;

  SELECT
    COUNT(*),
    COALESCE(SUM(effective_buy_usd), 0),
    COUNT(*) FILTER (WHERE is_primary_drop),
    COALESCE(SUM(effective_buy_usd) FILTER (WHERE is_primary_drop), 0),
    COUNT(*) FILTER (WHERE is_unknown_primary_buy),
    COUNT(*) FILTER (WHERE NOT is_primary_drop),
    COALESCE(SUM(price) FILTER (WHERE NOT is_primary_drop), 0),
    COUNT(*) FILTER (WHERE src = 'marketplace')
  INTO v_purchases_total, v_spent, v_primary_count, v_primary_spent, v_primary_unknown,
       v_secondary_count, v_secondary_spent, v_buys_marketplace
  FROM _wps_buys;

  SELECT
    COUNT(*),
    COALESCE(SUM(price), 0),
    COUNT(*) FILTER (WHERE NOT is_primary_drop),
    COALESCE(SUM(price) FILTER (WHERE NOT is_primary_drop), 0),
    COUNT(*) FILTER (WHERE src = 'marketplace')
  INTO v_sales_total, v_proceeds, v_secondary_sold_count, v_secondary_proceeds, v_sells_marketplace
  FROM _wps_sells;

  -- 2026-09-12: COUNT(pull_value_usd) counts NON-NULL only, which is exactly the
  -- coverage figure. Same scan as the COUNT(*) and SUM() beside it.
  SELECT COUNT(*), COUNT(pull_value_usd), COALESCE(SUM(pull_value_usd), 0), MIN(sealed_at), MAX(sealed_at),
         COUNT(*) FILTER (WHERE reconstructed)
  INTO v_rips_total, v_rips_valued, v_ripped_value, v_first_event, v_last_event, v_rips_reconstructed
  FROM _wps_rips;

  SELECT COALESCE(jsonb_object_agg(sale_currency, jsonb_build_object('purchases', purchases, 'sales', sales, 'spent', spent, 'proceeds', proceeds)), '{}'::jsonb)
  INTO v_currency_breakdown
  FROM (
    SELECT COALESCE(currency, 'UNKNOWN') AS sale_currency,
      SUM(purchases)::int AS purchases, SUM(sales)::int AS sales,
      ROUND(SUM(spent)::numeric, 2) AS spent, ROUND(SUM(proceeds)::numeric, 2) AS proceeds
    FROM (
      SELECT currency, 1 AS purchases, 0 AS sales, COALESCE(price, 0) AS spent, 0::numeric AS proceeds FROM _wps_buys
      UNION ALL
      SELECT currency, 0, 1, 0::numeric, COALESCE(price, 0) FROM _wps_sells
    ) u
    GROUP BY COALESCE(currency, 'UNKNOWN')
  ) cur;

  SELECT COALESCE(jsonb_agg(row_to_json(cb.*)::jsonb ORDER BY cb.activity_total DESC), '[]'::jsonb)
  INTO v_by_collection
  FROM (
    WITH purchases AS (
      SELECT collection_id, COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE is_primary_drop)::int AS primary_n,
             COUNT(*) FILTER (WHERE NOT is_primary_drop)::int AS secondary_n,
             COUNT(*) FILTER (WHERE is_unknown_primary_buy)::int AS unknown_primary_n,
             COALESCE(SUM(effective_buy_usd), 0)::numeric AS amt
      FROM _wps_buys GROUP BY collection_id
    ),
    sales AS (
      SELECT collection_id, COUNT(*)::int AS n, COALESCE(SUM(price), 0)::numeric AS amt
      FROM _wps_sells GROUP BY collection_id
    ),
    rips AS (
      SELECT collection_id, COUNT(*)::int AS n, COALESCE(SUM(pull_value_usd), 0)::numeric AS amt
      FROM _wps_rips GROUP BY collection_id
    ),
    all_coll AS (SELECT collection_id FROM purchases UNION SELECT collection_id FROM sales UNION SELECT collection_id FROM rips)
    SELECT c.id AS collection_id, c.slug AS collection_slug, c.name AS collection_name,
      COALESCE(p.n, 0) AS packs_purchased, COALESCE(p.primary_n, 0) AS primary_drops, COALESCE(p.secondary_n, 0) AS secondary_buys,
      COALESCE(p.unknown_primary_n, 0) AS primary_spend_unknown_count,
      COALESCE(s.n, 0) AS packs_sold, COALESCE(r.n, 0) AS packs_ripped,
      ROUND(COALESCE(p.amt, 0)::numeric, 2) AS spent_usd, ROUND(COALESCE(s.amt, 0)::numeric, 2) AS proceeds_usd, ROUND(COALESCE(r.amt, 0)::numeric, 2) AS ripped_value_usd,
      ROUND((COALESCE(s.amt,0) + COALESCE(r.amt,0) - COALESCE(p.amt,0))::numeric, 2) AS net_pl_usd,
      COALESCE(p.n, 0) + COALESCE(s.n, 0) + COALESCE(r.n, 0) AS activity_total
    FROM all_coll a JOIN public.collections c ON c.id = a.collection_id
    LEFT JOIN purchases p ON p.collection_id = a.collection_id
    LEFT JOIN sales s     ON s.collection_id = a.collection_id
    LEFT JOIN rips r      ON r.collection_id = a.collection_id
  ) cb;

  RETURN jsonb_build_object(
    'wallet', v_wallet,
    'totals', jsonb_build_object(
      'packs_purchased',                v_purchases_total,
      'primary_drops',                  v_primary_count,
      'secondary_buys',                 v_secondary_count,
      'packs_sold',                     v_sales_total,
      'packs_ripped',                   v_rips_total,
      'ripped_value_known_count',       v_rips_valued,
      'packs_ripped_reconstructed',     v_rips_reconstructed,
      'buys_from_marketplace_history',  v_buys_marketplace,
      'sells_from_marketplace_history', v_sells_marketplace,
      'spent_usd',                      ROUND(COALESCE(v_spent, 0)::numeric, 2),
      'primary_spent_usd',              ROUND(COALESCE(v_primary_spent, 0)::numeric, 2),
      'primary_spend_unknown_count',    v_primary_unknown,
      'secondary_spent_usd',            ROUND(COALESCE(v_secondary_spent, 0)::numeric, 2),
      'sold_proceeds_usd',              ROUND(COALESCE(v_proceeds, 0)::numeric, 2),
      'secondary_proceeds_usd',         ROUND(COALESCE(v_secondary_proceeds, 0)::numeric, 2),
      'ripped_value_usd',               ROUND(COALESCE(v_ripped_value, 0)::numeric, 2),
      'net_pl_usd',                     ROUND((COALESCE(v_proceeds, 0) + COALESCE(v_ripped_value, 0) - COALESCE(v_spent, 0))::numeric, 2),
      'first_event_at',                 v_first_event,
      'last_event_at',                  v_last_event
    ),
    'by_currency', v_currency_breakdown,
    'by_collection', v_by_collection,
    'computed_at', now(),
    'note', 'Buys and sells are one row per (collection, pack) across public.pack_purchases (on-chain: secondary_sale + primary_withdraw/primary_mint, block-indexed from 2026-04) and the Dapper marketplace history tables topshot_pack_sales_history / allday_pack_sales_history / golazos_pack_sales_history (seller = storefront_address; Top Shot from 2023-09, All Day from 2022-12; bursty ingest). pack_purchases.seller_address is the transaction PAYER, which on Dapper is the escrow account, so on-chain rows almost never identify a seller -- packs_sold comes from the marketplace tables. Primary drop sale_price is NULL on-chain; primary_spent_usd recovers retail via pack_distributions.metadata->>retail_price_usd and primary_spend_unknown_count counts the rest. Top Shot shop buys (pack_purchases.custom_id = nba, labelled secondary_sale on ingest) count as primary drops at the price paid. ripped_value_known_count is how many of packs_ripped carry a pull_value_usd -- ripped_value_usd sums THOSE only. packs_ripped counts Top Shot + All Day rips (pack_rips) and Golazos + Pinnacle opens; a pull value comes from Dapper''s list of the moments the pack yielded (pack_open_pull_values, current FMV, whole-pack) first, the open row''s own value otherwise. packs_ripped_reconstructed of packs_ripped are Top Shot packs opened with no pack NFT, rebuilt from the wallet''s moment deliveries (wallet_reconstructed_rips).'
  );
END;
$function$;
