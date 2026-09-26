-- DB invariant: public.get_wallet_pack_summary — the wallet pack P&L hero
-- (/dashboard/packs, the Collection tab's Packs body, the sold-packs alert).
-- Pinned 2026-09-18 when packs_sold went from "pack_purchases.seller_address =
-- wallet" (the transaction PAYER = Dapper's escrow, so 0 for every wallet) to
-- a union with the Dapper marketplace history tables, whose storefront_address
-- IS the seller. Also pins: one purchase seen by both sources counts once; a
-- primary drop with no retail price is counted in primary_spend_unknown_count
-- and contributes nothing to spent; a cancelled listing counts as nothing.
--
-- 2026-09-25 (#134): a Top Shot SHOP buy (custom_id 'nba', labelled secondary_sale
-- on ingest) counts as a PRIMARY drop at the price paid; All Day rows are not shop
-- rows. Pinned by the separate 0xshopper wallet below.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260926210200_audit_20260926_wallet_pack_summary_judges_allday_against_real_drop_windows.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text UNIQUE, name text);
CREATE TABLE public.pack_purchases (
  id uuid DEFAULT gen_random_uuid(), collection_id uuid, pack_nft_id text,
  buyer_address text, seller_address text, sale_price numeric, sale_currency text,
  sealed_at timestamptz, is_primary_drop boolean DEFAULT false, event_kind text, pack_dist_id text,
  custom_id text
);
CREATE TABLE public.topshot_pack_sales_history (
  tx_hash text, pack_nft_id text, sale_price_usd numeric, purchased boolean,
  buyer_address text, storefront_address text, dist_id text, block_time timestamptz
);
CREATE TABLE public.allday_pack_sales_history (LIKE public.topshot_pack_sales_history);
CREATE TABLE public.pack_rips (
  id uuid DEFAULT gen_random_uuid(), collection_id uuid, pack_nft_id text, opener_address text,
  moments_pulled int, sealed_at timestamptz, dist_id text, pull_value_usd numeric
);
CREATE TABLE public.pack_distributions (collection_id uuid, dist_id text, title text, image_url text, metadata jsonb);
-- 2026-09-26
CREATE TABLE public.golazos_pack_sales_history (LIKE public.topshot_pack_sales_history);
CREATE TABLE public.golazos_pack_opens (pack_nft_id text, dist_id text, opener_address text, opened_at timestamptz, moments_pulled int, pull_value_usd numeric);
CREATE TABLE public.pinnacle_pack_opens (LIKE public.golazos_pack_opens);
CREATE TABLE public.wallet_reconstructed_rips (wallet text, collection_id uuid, burst_id text, opened_at timestamptz,
  moments_pulled int, nft_ids text[] DEFAULT '{}', n_resolved int, n_priced int, pull_value_usd numeric(14,2));
CREATE TABLE public.pack_open_pull_values (
  collection_id uuid, pack_nft_id text, opener_address text, n_pulls int, n_resolved int, n_priced int,
  pull_value_usd numeric(14,2), priced_at timestamptz DEFAULT now(), PRIMARY KEY (collection_id, pack_nft_id));

-- 2026-09-26 (v10): retail normalisation helper + All Day drop prices
CREATE OR REPLACE FUNCTION public.pack_retail_usd(p_raw text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path TO 'public'
AS $function$
  -- A pack's retail price in DOLLARS from pack_distributions.metadata->>'retail_price_usd',
  -- which carries some Top Shot prices in UFix64 units (x1e8). The estate's rule
  -- (lib/packs/normalize-retail-price.ts): >= 1,000,000 is UFix64. Unlike that
  -- helper, unknown stays NULL (never 0); 0 stays 0 (a reward pack's known price).
  SELECT CASE
           WHEN p_raw IS NULL OR p_raw !~ '^\s*[0-9]+(\.[0-9]+)?\s*$' THEN NULL
           WHEN p_raw::numeric >= 1000000 THEN round(p_raw::numeric / 100000000, 2)
           ELSE p_raw::numeric
         END
$function$;
CREATE TABLE IF NOT EXISTS public.allday_pack_supply (dist_id text PRIMARY KEY, pack_price numeric);

-- 2026-09-26 (v11): title-aware retail + Dapper mint receipts
CREATE OR REPLACE FUNCTION public.pack_retail_usd(p_raw text, p_title text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path TO 'public'
AS $function$
  -- A drop's retail in DOLLARS, knowing which drop it is: a Trade Ticket pack is
  -- bought with Trade Tickets, and its retail_price_usd is the ticket price --
  -- no dollar amount exists, so NULL (unknown), never the ticket count as $.
  SELECT CASE WHEN p_title ILIKE '%trade ticket%' THEN NULL
              ELSE public.pack_retail_usd(p_raw) END
$function$;
-- 2026-09-26 (v12): All Day drop windows from Dapper
CREATE TABLE public.allday_drop_windows (dist_id text PRIMARY KEY, start_time timestamptz, end_time timestamptz,
  price_usd numeric(14,2), title text, fetched_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.pack_nft_mints (collection_id uuid, pack_nft_id text, dist_id text, minted_at timestamptz,
  block_height bigint, tx_id text, first_seen_at timestamptz DEFAULT now(), PRIMARY KEY (collection_id, pack_nft_id));
CREATE TABLE IF NOT EXISTS public.pack_nft_identity (collection_id uuid, pack_nft_id text, dist_id text, status text, owner_address text, checked_at timestamptz DEFAULT now(), acquired_at timestamptz, PRIMARY KEY (collection_id, pack_nft_id));

-- >>> BEGIN verbatim get_wallet_pack_summary (body byte-identical to the migration) >>>
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
  v_inf_count int; v_inf_spent numeric; v_inf_unpriced int;
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
    -- 2026-09-26: retail in DOLLARS (pack_retail_usd normalises Top Shot's
    -- UFix64-unit prices; All Day's drop price lives in allday_pack_supply).
    CASE WHEN l.is_primary_drop THEN
      COALESCE(
        public.pack_retail_usd(pd_direct.metadata->>'retail_price_usd', pd_direct.title),
        public.pack_retail_usd(pd_via_rip.metadata->>'retail_price_usd', pd_via_rip.title),
        CASE WHEN l.collection_id = v_ad AND COALESCE(pd_direct.metadata, pd_via_rip.metadata)->>'type' = 'REWARD' THEN 0::numeric
             ELSE NULLIF(aps.pack_price, 0) END
      )
    ELSE l.price END AS effective_buy_usd,
    (l.is_primary_drop AND
      COALESCE(
        public.pack_retail_usd(pd_direct.metadata->>'retail_price_usd', pd_direct.title),
        public.pack_retail_usd(pd_via_rip.metadata->>'retail_price_usd', pd_via_rip.title),
        CASE WHEN l.collection_id = v_ad AND COALESCE(pd_direct.metadata, pd_via_rip.metadata)->>'type' = 'REWARD' THEN 0::numeric
             ELSE NULLIF(aps.pack_price, 0) END
      ) IS NULL
    ) AS is_unknown_primary_buy
  FROM latest l
  LEFT JOIN any_dist ad ON ad.collection_id = l.collection_id AND ad.pack_nft_id = l.pack_nft_id
  LEFT JOIN public.pack_distributions pd_direct
    ON pd_direct.dist_id = ad.dist_id AND pd_direct.collection_id = l.collection_id
  LEFT JOIN public.pack_rips pr
    ON pr.pack_nft_id = l.pack_nft_id AND pr.collection_id = l.collection_id
  LEFT JOIN public.pack_distributions pd_via_rip
    ON pd_via_rip.dist_id = pr.dist_id AND pd_via_rip.collection_id = l.collection_id
  LEFT JOIN public.allday_pack_supply aps
    ON l.collection_id = v_ad AND aps.dist_id = COALESCE(ad.dist_id, pr.dist_id);

  CREATE TEMP TABLE _wps_sells ON COMMIT DROP AS
  WITH sell_src AS (
    SELECT pp.pack_nft_id, pp.collection_id, pp.sale_price AS price, pp.sale_currency AS currency,
           pp.sealed_at AS at, pp.is_primary_drop, 'onchain'::text AS src, 1 AS pri, pp.pack_dist_id AS dist_id
    FROM public.pack_purchases pp WHERE pp.seller_address = v_wallet
    UNION ALL
    SELECT h.pack_nft_id, v_ts, h.sale_price_usd, 'USD', h.block_time, false, 'marketplace', 2, h.dist_id
    FROM public.topshot_pack_sales_history h WHERE h.storefront_address = v_wallet AND h.purchased
    UNION ALL
    SELECT h.pack_nft_id, v_ad, h.sale_price_usd, 'USD', h.block_time, false, 'marketplace', 2, h.dist_id
    FROM public.allday_pack_sales_history h WHERE h.storefront_address = v_wallet AND h.purchased
    UNION ALL
    SELECT h.pack_nft_id, v_gz, h.sale_price_usd, 'USD', h.block_time, false, 'marketplace', 2, h.dist_id
    FROM public.golazos_pack_sales_history h WHERE h.storefront_address = v_wallet AND h.purchased
  )
  SELECT DISTINCT ON (collection_id, pack_nft_id) *
  FROM sell_src ORDER BY collection_id, pack_nft_id, at DESC, pri;

  -- 2026-09-26: every pack the wallet OPENED -- Top Shot + All Day rips and the
  -- Golazos / Pinnacle open tables (pack_rips holds neither) -- valued from
  -- Dapper's list of the moments each pack yielded (pack_open_pull_values, same
  -- opener) first, the open row's own value otherwise. NULL stays NULL.
  CREATE TEMP TABLE _wps_rips ON COMMIT DROP AS
  SELECT o.collection_id, o.pack_nft_id, o.sealed_at, o.reconstructed, o.dist_id,
         COALESCE(pov.pull_value_usd, o.pull_value_usd) AS pull_value_usd
  FROM (
    SELECT collection_id, pack_nft_id, sealed_at, pull_value_usd, false AS reconstructed, dist_id
    FROM public.pack_rips WHERE opener_address = v_wallet
    UNION ALL
    SELECT v_gz, pack_nft_id, opened_at, pull_value_usd, false, dist_id
    FROM public.golazos_pack_opens WHERE opener_address = v_wallet
    UNION ALL
    SELECT v_pin, pack_nft_id, opened_at, pull_value_usd, false, dist_id
    FROM public.pinnacle_pack_opens WHERE opener_address = v_wallet
    UNION ALL
    -- 2026-09-26: packs opened with no pack NFT, reconstructed from delivery
    -- bursts (wallet_reconstructed_rips); counted, and counted separately.
    SELECT collection_id, burst_id, opened_at, pull_value_usd, true, NULL::text
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

  -- 2026-09-26: packs the wallet SOLD or OPENED with no buy row we hold, acquired
  -- inside their drop's sale window (start_time - 1 day .. + 30 days; Dapper's
  -- index date, else bounded by the first sale / open) where the marketplace
  -- history covers that window (Top Shot; All Day drops from 2022-12-16) --
  -- priced at the drop's retail, reported SEPARATELY from spent_usd.
  -- Reconstructed rips have no distribution and are never inferred.
  SELECT count(*) FILTER (WHERE x.retail IS NOT NULL), COALESCE(sum(x.retail), 0), count(*) FILTER (WHERE x.retail IS NULL)
    INTO v_inf_count, v_inf_spent, v_inf_unpriced
  FROM (
    SELECT CASE WHEN k.collection_id = v_ad
                THEN CASE WHEN pd.metadata->>'type' = 'REWARD' THEN 0::numeric
                          ELSE (SELECT NULLIF(s2.pack_price, 0) FROM public.allday_pack_supply s2 WHERE s2.dist_id = k.dist_id) END
                ELSE public.pack_retail_usd(pd.metadata->>'retail_price_usd', pd.title)
           END AS retail
    FROM (
      SELECT u.collection_id, u.pack_nft_id, max(u.dist_id) AS dist_id, min(u.at) AS first_at
      FROM (
        SELECT collection_id, pack_nft_id, dist_id, sealed_at AS at FROM _wps_rips WHERE NOT reconstructed
        UNION ALL
        SELECT collection_id, pack_nft_id, dist_id, at FROM _wps_sells
      ) u
      GROUP BY u.collection_id, u.pack_nft_id
      HAVING max(u.dist_id) IS NOT NULL
    ) k
    LEFT JOIN public.pack_distributions pd
      ON pd.dist_id = k.dist_id AND pd.collection_id = k.collection_id
    LEFT JOIN public.pack_nft_identity i
      ON i.collection_id = k.collection_id AND i.pack_nft_id = k.pack_nft_id AND i.owner_address = v_wallet
    -- v12: All Day drop dates from Dapper's distribution record where
    -- pack_distributions carries none
    LEFT JOIN public.allday_drop_windows adw
      ON k.collection_id = v_ad AND adw.dist_id = k.dist_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(
               CASE WHEN pg_input_is_valid(pd.metadata->>'start_time', 'timestamptz')
                    THEN (pd.metadata->>'start_time')::timestamptz END,
               adw.start_time) AS drop_start
    ) ds
    WHERE NOT EXISTS (SELECT 1 FROM _wps_buys b WHERE b.collection_id = k.collection_id AND b.pack_nft_id = k.pack_nft_id)
      -- the history's rule: acquired inside the drop's sale window, and the
      -- marketplace history covers that window ...
      AND ((ds.drop_start IS NOT NULL
            AND (k.collection_id = v_ts OR (k.collection_id = v_ad AND ds.drop_start >= timestamptz '2022-12-16'))
            AND COALESCE(i.acquired_at, k.first_at)
                  BETWEEN ds.drop_start - interval '1 day' AND ds.drop_start + interval '30 days')
           -- ... or (v11, Top Shot) Dapper minted it straight into this wallet
           -- at the index's acquisition instant (pack_nft_mints)
           OR (k.collection_id = v_ts AND i.acquired_at IS NOT NULL
               AND EXISTS (SELECT 1 FROM public.pack_nft_mints m
                            WHERE m.collection_id = k.collection_id AND m.pack_nft_id = k.pack_nft_id
                              AND abs(extract(epoch FROM m.minted_at - i.acquired_at)) <= 2)))
  ) x;

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
      'inferred_primary_count',         v_inf_count,
      'inferred_primary_spent_usd',     ROUND(COALESCE(v_inf_spent, 0)::numeric, 2),
      'inferred_primary_unpriced_count', v_inf_unpriced,
      'net_pl_incl_inferred_usd',       ROUND((COALESCE(v_proceeds, 0) + COALESCE(v_ripped_value, 0) - COALESCE(v_spent, 0) - COALESCE(v_inf_spent, 0))::numeric, 2),
      'first_event_at',                 v_first_event,
      'last_event_at',                  v_last_event
    ),
    'by_currency', v_currency_breakdown,
    'by_collection', v_by_collection,
    'computed_at', now(),
    'note', 'Buys and sells are one row per (collection, pack) across public.pack_purchases (on-chain: secondary_sale + primary_withdraw/primary_mint, block-indexed from 2026-04) and the Dapper marketplace history tables topshot_pack_sales_history / allday_pack_sales_history / golazos_pack_sales_history (seller = storefront_address; Top Shot from 2023-09, All Day from 2022-12; bursty ingest). pack_purchases.seller_address is the transaction PAYER, which on Dapper is the escrow account, so on-chain rows almost never identify a seller -- packs_sold comes from the marketplace tables. Primary drop sale_price is NULL on-chain; primary_spent_usd recovers retail via pack_distributions.metadata->>retail_price_usd and primary_spend_unknown_count counts the rest (a Trade Ticket pack''s retail is a ticket price, never dollars: unknown; an All Day distribution Dapper types REWARD is $0). Top Shot shop buys (pack_purchases.custom_id = nba, labelled secondary_sale on ingest) count as primary drops at the price paid. ripped_value_known_count is how many of packs_ripped carry a pull_value_usd -- ripped_value_usd sums THOSE only. packs_ripped counts Top Shot + All Day rips (pack_rips) and Golazos + Pinnacle opens; a pull value comes from Dapper''s list of the moments the pack yielded (pack_open_pull_values, current FMV, whole-pack) first, the open row''s own value otherwise. packs_ripped_reconstructed of packs_ripped are Top Shot packs opened with no pack NFT, rebuilt from the wallet''s moment deliveries (wallet_reconstructed_rips). inferred_primary_* are packs sold or opened with no buy row, acquired inside their drop''s sale window (start_time - 1 day .. + 30 days) where the marketplace history covers it (Top Shot; All Day drops from 2022-12-16, dates from Dapper''s distribution record) or -- Top Shot -- minted by Dapper straight into this wallet (pack_nft_mints), priced at the drop''s retail -- an inference kept OUT of spent_usd; net_pl_incl_inferred_usd subtracts it.'
  );
END;
$function$;
-- <<< END verbatim get_wallet_pack_summary <<<

INSERT INTO public.collections VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot', 'NBA Top Shot'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'nfl_all_day', 'NFL All Day'),
  ('06248cc4-b85f-47cd-af67-1855d14acd75', 'laliga_golazos', 'LaLiga Golazos'),
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'disney_pinnacle', 'Disney Pinnacle');
INSERT INTO public.pack_distributions VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'D1', 'Fresh Threads Pack', NULL, '{"retail_price_usd":"10"}');

-- buys: B1 primary drop, dist known via the rip (retail 10); B2 primary drop, no dist (unknown);
-- B3 secondary on chain 8 DUC AND the same purchase in the marketplace table (once);
-- B4 marketplace-only 2024 buy $30; AD1 All Day marketplace buy $4.
INSERT INTO public.pack_purchases (collection_id, pack_nft_id, buyer_address, seller_address, sale_price, sale_currency, sealed_at, is_primary_drop, event_kind) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'B1', '0xwallet', '0x0b2a3299cc857e29', NULL, NULL, '2026-05-01', true, 'primary_withdraw'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'B2', '0xwallet', '0x0b2a3299cc857e29', NULL, NULL, '2026-05-02', true, 'primary_withdraw'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'B3', '0xwallet', '0x18eb4ee6b3c026d2', 8, 'DUC', '2026-08-01 10:00:00', false, 'secondary_sale');
INSERT INTO public.pack_rips (collection_id, pack_nft_id, opener_address, moments_pulled, sealed_at, dist_id, pull_value_usd) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'B1', '0xwallet', 3, '2026-05-03', 'D1', 12.5);
INSERT INTO public.topshot_pack_sales_history VALUES
  ('t-b3', 'B3', 8, true, '0xwallet', '0xseller', 'D1', '2026-08-01 10:00:00'),
  ('t-b4', 'B4', 30, true, '0xwallet', '0xseller', 'D1', '2024-05-01');
INSERT INTO public.allday_pack_sales_history VALUES
  ('a-1', 'AD1', 4, true, '0xwallet', '0xseller', 'X1', '2025-01-01');
-- sells: S1, S2 Top Shot marketplace ($25 + $40); S3 All Day marketplace ($7);
-- one cancelled listing ($99, purchased=false) that must count as nothing;
-- one on-chain row whose seller_address really is the wallet ($3).
INSERT INTO public.topshot_pack_sales_history VALUES
  ('t-s1', 'S1', 25, true, '0xother', '0xwallet', 'D1', '2026-06-01'),
  ('t-s2', 'S2', 40, true, '0xother', '0xwallet', 'D1', '2024-03-01'),
  ('t-s9', 'S9', 99, false, '0xother', '0xwallet', 'D1', '2026-08-20');
INSERT INTO public.allday_pack_sales_history VALUES
  ('a-s3', 'S3', 7, true, '0xother', '0xwallet', 'X1', '2025-02-01');
INSERT INTO public.pack_purchases (collection_id, pack_nft_id, buyer_address, seller_address, sale_price, sale_currency, sealed_at, is_primary_drop, event_kind) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'S4', '0xother', '0xwallet', 3, 'DUC', '2026-08-02', false, 'secondary_sale');

DO $$
DECLARE
  r jsonb; t jsonb; ts jsonb; ad jsonb;
BEGIN
  r := public.get_wallet_pack_summary('0xWALLET');
  t := r->'totals';
  PERFORM _assert_eq(t->>'packs_purchased', '5', 'B1 B2 B3 B4 AD1 — B3 seen twice counts once');
  PERFORM _assert_eq(t->>'buys_from_marketplace_history', '2', 'B4 + AD1 only exist in the marketplace tables');
  PERFORM _assert_eq(t->>'primary_drops', '2', 'B1 B2');
  PERFORM _assert_eq(t->>'secondary_buys', '3', 'B3 B4 AD1');
  PERFORM _assert_eq(t->>'primary_spend_unknown_count', '1', 'B2 has no recoverable retail');
  PERFORM _assert_eq(t->>'spent_usd', '52.00', '10 retail + 8 + 30 + 4; B2 contributes nothing, not $0-as-a-fact');
  PERFORM _assert_eq(t->>'primary_spent_usd', '10.00', 'B1 at retail');
  PERFORM _assert_eq(t->>'secondary_spent_usd', '42.00', '8 + 30 + 4');
  PERFORM _assert_eq(t->>'packs_sold', '4', 'S1 S2 S3 + the on-chain S4; the cancelled S9 is nothing');
  PERFORM _assert_eq(t->>'sells_from_marketplace_history', '3', 'S1 S2 S3');
  PERFORM _assert_eq(t->>'sold_proceeds_usd', '75.00', '25 + 40 + 7 + 3');
  PERFORM _assert_eq(t->>'packs_ripped', '1', 'B1');
  PERFORM _assert_eq(t->>'ripped_value_known_count', '1', 'B1 valued');
  PERFORM _assert_eq(t->>'ripped_value_usd', '12.50', 'B1 pull value');
  PERFORM _assert_eq(t->>'net_pl_usd', '35.50', '75 + 12.5 - 52');

  SELECT c INTO ts FROM jsonb_array_elements(r->'by_collection') c WHERE c->>'collection_slug' = 'nba_top_shot';
  SELECT c INTO ad FROM jsonb_array_elements(r->'by_collection') c WHERE c->>'collection_slug' = 'nfl_all_day';
  PERFORM _assert_eq(ts->>'packs_purchased', '4', 'TS buys B1 B2 B3 B4');
  PERFORM _assert_eq(ts->>'packs_sold', '3', 'TS sells S1 S2 S4');
  PERFORM _assert_eq(ts->>'proceeds_usd', '68.00', 'TS proceeds 25 + 40 + 3');
  PERFORM _assert_eq(ts->>'primary_spend_unknown_count', '1', 'TS unknown primary = B2');
  PERFORM _assert_eq(ad->>'packs_purchased', '1', 'AD buys AD1');
  PERFORM _assert_eq(ad->>'packs_sold', '1', 'AD sells S3');
  PERFORM _assert_eq(ad->>'net_pl_usd', '3.00', 'AD 7 - 4');

  PERFORM _assert_eq(r->'by_currency'->'USD'->>'sales', '3', 'USD sales = the three marketplace sells');
  PERFORM _assert_eq(r->'by_currency'->'DUC'->>'sales', '1', 'DUC sales = S4');
  PERFORM _assert_eq(r->'by_currency'->'UNKNOWN'->>'purchases', '2', 'the two unpriced primary drops carry no currency');

  PERFORM _assert_eq((public.get_wallet_pack_summary('0xnobody')->'totals')->>'packs_sold', '0', 'unknown wallet -> zeros, not error');
  PERFORM _assert((public.get_wallet_pack_summary(''))->>'error' = 'wallet required', 'empty wallet -> error');
END $$;

-- #134: a separate wallet so the fixtures above keep their numbers.
-- SH1 Top Shot SHOP buy $10 (custom_id 'nba', no dist -> if it were priced at
-- retail it would be an UNKNOWN primary); SH2 Top Shot marketplace buy $7;
-- SH3 an All Day row carrying custom_id 'nba' ($5) -- not the Top Shot shop.
INSERT INTO public.pack_purchases (collection_id, pack_nft_id, buyer_address, seller_address, sale_price, sale_currency, sealed_at, is_primary_drop, event_kind, custom_id) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'SH1', '0xshopper', '0x0b2a3299cc857e29', 10, 'DUC', '2026-08-10', false, 'secondary_sale', 'nba'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'SH2', '0xshopper', '0x18eb4ee6b3c026d2', 7, 'DUC', '2026-08-11', false, 'secondary_sale', 'DAPPER_MARKETPLACE'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'SH3', '0xshopper', '0x18eb4ee6b3c026d2', 5, 'DUC', '2026-08-12', false, 'secondary_sale', 'nba');

DO $$
DECLARE t jsonb;
BEGIN
  t := public.get_wallet_pack_summary('0xshopper')->'totals';
  PERFORM _assert_eq(t->>'packs_purchased', '3', 'SH1 SH2 SH3');
  PERFORM _assert_eq(t->>'primary_drops', '1', 'the Top Shot shop buy SH1 is primary');
  PERFORM _assert_eq(t->>'secondary_buys', '2', 'SH2 (marketplace) and SH3 (All Day, not the Top Shot shop)');
  PERFORM _assert_eq(t->>'primary_spent_usd', '10.00', 'SH1 at the price PAID, not retail');
  PERFORM _assert_eq(t->>'primary_spend_unknown_count', '0', 'a shop buy has a price, so it is never an unknown primary');
  PERFORM _assert_eq(t->>'secondary_spent_usd', '12.00', '7 + 5');
  PERFORM _assert_eq(t->>'spent_usd', '22.00', 'total unchanged by the split');
END $$;

-- 2026-09-26: opens from every collection, valued from Dapper's pull lists first.
-- R1 Top Shot rip unvalued on its row, priced 9.00 by its pull list; R2 Top Shot
-- rip valued 4.00, its pull list partly priced (NULL) -> 4.00 stands; R3 a
-- pull value keyed to ANOTHER opener -> ignored, R3 stays unvalued; GO1 a Golazos
-- open 2.00 (pull list 2.50 wins); PO1 a Pinnacle open, unvalued. GB1/GS1 a
-- Golazos market buy $6 / sale $11.
INSERT INTO public.pack_rips (collection_id, pack_nft_id, opener_address, moments_pulled, sealed_at, dist_id, pull_value_usd) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'R1', '0xopener', 3, '2026-09-01', 'D1', NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'R2', '0xopener', 3, '2026-09-02', 'D1', 4),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'R3', '0xopener', 3, '2026-09-03', 'D1', NULL);
INSERT INTO public.pack_open_pull_values (collection_id, pack_nft_id, opener_address, n_pulls, n_resolved, n_priced, pull_value_usd) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'R1', '0xopener', 3, 3, 3, 9.00),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'R2', '0xopener', 3, 2, 2, NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'R3', '0xelse', 3, 3, 3, 50.00),
  ('06248cc4-b85f-47cd-af67-1855d14acd75', 'GO1', '0xopener', 4, 4, 4, 2.50);
INSERT INTO public.golazos_pack_opens VALUES ('GO1', 'GD', '0xopener', '2026-09-04', 4, 2.00);
INSERT INTO public.pinnacle_pack_opens VALUES ('PO1', 'PD', '0xopener', '2026-09-05', 5, NULL);
INSERT INTO public.golazos_pack_sales_history VALUES
  ('g-b1', 'GB1', 6, true, '0xopener', '0xs', 'GD', '2026-09-06'),
  ('g-s1', 'GS1', 11, true, '0xb', '0xopener', 'GD', '2026-09-07');

DO $$
DECLARE t jsonb; gz jsonb;
BEGIN
  t := public.get_wallet_pack_summary('0xopener')->'totals';
  PERFORM _assert_eq(t->>'packs_ripped', '5', 'R1 R2 R3 + the Golazos and Pinnacle opens');
  PERFORM _assert_eq(t->>'ripped_value_known_count', '3', 'R1 (pull list) R2 (rip row) GO1 -- never R3 (another opener) or PO1');
  PERFORM _assert_eq(t->>'ripped_value_usd', '15.50', '9.00 + 4.00 + 2.50');
  PERFORM _assert_eq(t->>'packs_purchased', '1', 'GB1 Golazos market buy');
  PERFORM _assert_eq(t->>'packs_sold', '1', 'GS1 Golazos market sale');
  SELECT c INTO gz FROM jsonb_array_elements(public.get_wallet_pack_summary('0xopener')->'by_collection') c WHERE c->>'collection_slug' = 'laliga_golazos';
  PERFORM _assert(gz IS NOT NULL, 'Golazos has its own by_collection row');
END $$;

-- reconstructed rips count, and count separately
INSERT INTO public.wallet_reconstructed_rips (wallet, collection_id, burst_id, opened_at, moments_pulled, n_resolved, n_priced, pull_value_usd) VALUES
  ('0xopener', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'burst:1', '2022-01-01', 3, 3, 3, 6.00),
  ('0xopener', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'burst:2', '2022-01-02', 2, 1, 1, NULL),
  ('0xelse',   '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'burst:3', '2022-01-03', 1, 1, 1, 50.00);
DO $$
DECLARE t jsonb;
BEGIN
  t := public.get_wallet_pack_summary('0xopener')->'totals';
  PERFORM _assert_eq(t->>'packs_ripped', '7', '5 opens + 2 reconstructed');
  PERFORM _assert_eq(t->>'packs_ripped_reconstructed', '2', 'the reconstructed share is published');
  PERFORM _assert_eq(t->>'ripped_value_known_count', '4', '3 + burst:1');
  PERFORM _assert_eq(t->>'ripped_value_usd', '21.50', '15.50 + 6.00; never another wallet''s burst');
  PERFORM _assert_eq(t->>'first_event_at', '2022-01-01T00:00:00+00:00', 'history now starts at the first reconstructed rip');
END $$;

-- v10 (2026-09-26): retail in dollars; inferred acquisitions reported apart.
INSERT INTO public.pack_distributions VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'DU', 'UFix Pack', NULL, '{"retail_price_usd":"4990000000"}'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'DS', 'Fifteen Pack', NULL, '{"retail_price_usd":"15","start_time":"2025-04-20T00:00:00Z"}'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'A99', 'AD Drop', NULL, '{"start_time":"2024-05-25T00:00:00Z"}');
-- I5: a TS pack sold a YEAR after its drop, no buy row -> outside the window -> never inferred
INSERT INTO public.topshot_pack_sales_history VALUES ('t-i5', 'I5', 70, true, '0xb', '0xinf', 'DS', '2026-05-01');
INSERT INTO public.allday_pack_supply VALUES ('A99', 99);
-- I1 a recorded TS primary buy on a UFix64 dist; I2 a TS pack SOLD for 40 with no
-- buy row (retail 15 inferred); I3 an All Day rip acquired 2024 per the index
-- (99 inferred); I4 an All Day rip with no index row (not inferable).
INSERT INTO public.pack_purchases (collection_id, pack_nft_id, buyer_address, seller_address, sale_price, sale_currency, sealed_at, is_primary_drop, event_kind, pack_dist_id) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'I1', '0xinf', '0x0b2a3299cc857e29', NULL, NULL, '2026-07-01', true, 'primary_withdraw', 'DU');
INSERT INTO public.topshot_pack_sales_history VALUES ('t-i2', 'I2', 40, true, '0xb', '0xinf', 'DS', '2025-05-01');
INSERT INTO public.pack_rips (collection_id, pack_nft_id, opener_address, moments_pulled, sealed_at, dist_id, pull_value_usd) VALUES
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'I3', '0xinf', 3, '2025-01-02', 'A99', 20),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'I4', '0xinf', 3, '2025-01-03', 'A99', 5);
INSERT INTO public.pack_nft_identity VALUES ('dee28451-5d62-409e-a1ad-a83f763ac070', 'I3', 'A99', 'Opened', '0xinf', now(), '2024-06-01');

DO $$
DECLARE t jsonb;
BEGIN
  t := public.get_wallet_pack_summary('0xinf')->'totals';
  PERFORM _assert_eq(t->>'primary_spent_usd', '49.90', 'a UFix64 retail is $49.90 of spend, not $4.99bn');
  PERFORM _assert_eq(t->>'spent_usd', '49.90', 'recorded spend excludes every inference');
  PERFORM _assert_eq(t->>'inferred_primary_count', '2', 'I2 (TS sold 11 days into its drop) + I3 (AD acquired 7 days into its drop); never I1 (recorded), I4 (no index date, rip outside the window) or I5');
  PERFORM _assert_eq(t->>'inferred_primary_spent_usd', '114.00', '15 + 99');
  PERFORM _assert_eq(t->>'net_pl_usd', '85.10', '40 + 70 + 25 - 49.90 -- the recorded view is unchanged');
  PERFORM _assert_eq(t->>'net_pl_incl_inferred_usd', '-28.90', '85.10 - 114; I5 (sold a year after its drop) is never inferred');
END $$;

-- v11 (2026-09-26): a Top Shot pack Dapper minted into the wallet is inferred at
-- retail however late; a Trade Ticket pack is never dollars.
INSERT INTO public.pack_distributions VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'M9', 'Anthology Quick Rip', NULL, '{"retail_price_usd":"9","start_time":"2024-06-06T19:30:00Z"}'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'MT', 'Holo Icon Trade Ticket Pack', NULL, '{"retail_price_usd":"10","start_time":"2026-01-15T20:00:00Z"}'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'MA', 'AD Old Drop', NULL, '{"start_time":"2024-01-01T00:00:00Z"}');
INSERT INTO public.allday_pack_supply VALUES ('MA', 50);
-- M1 TS rip minted in (inferred 9); M2 the same with no mint (not inferred);
-- M3 All Day rip minted in (not inferred); M5 a Trade Ticket rip minted in
-- (inferred but unpriced); M4 a RECORDED Trade Ticket primary buy (unknown spend).
INSERT INTO public.pack_rips (collection_id, pack_nft_id, opener_address, moments_pulled, sealed_at, dist_id, pull_value_usd) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'M1', '0xmint', 3, '2026-05-01', 'M9', 12),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'M2', '0xmint', 3, '2026-05-01', 'M9', 12),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'M3', '0xmint', 3, '2026-05-01', 'MA', 12),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'M5', '0xmint', 3, '2026-05-01', 'MT', 12);
INSERT INTO public.pack_nft_identity VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'M1', 'M9', 'Opened', '0xmint', now(), '2026-04-24 11:15:01.118+00'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'M2', 'M9', 'Opened', '0xmint', now(), '2026-04-24 11:15:01.118+00'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'M3', 'MA', 'Opened', '0xmint', now(), '2026-04-24 11:15:01.118+00'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'M5', 'MT', 'Opened', '0xmint', now(), '2026-04-24 11:15:01.118+00');
INSERT INTO public.pack_nft_mints (collection_id, pack_nft_id, dist_id, minted_at, block_height, tx_id) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'M1', 'M9', '2026-04-24 11:15:01.118+00', 149445000, 'tx-mint'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'M3', 'MA', '2026-04-24 11:15:01.118+00', 149445000, 'tx-mint'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'M5', 'MT', '2026-04-24 11:15:01.118+00', 149445000, 'tx-mint');
INSERT INTO public.pack_purchases (collection_id, pack_nft_id, buyer_address, seller_address, sale_price, sale_currency, sealed_at, is_primary_drop, event_kind, pack_dist_id) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'M4', '0xmint', '0x0b2a3299cc857e29', NULL, NULL, '2026-01-16', true, 'primary_withdraw', 'MT');

DO $$
DECLARE t jsonb;
BEGIN
  t := public.get_wallet_pack_summary('0xmint')->'totals';
  PERFORM _assert_eq(t->>'inferred_primary_count', '1', 'M1 only: never M2 (no mint), M3 (All Day) or M5 (Trade Ticket has no dollar price)');
  PERFORM _assert_eq(t->>'inferred_primary_spent_usd', '9.00', 'M1 at its $9 retail');
  PERFORM _assert_eq(t->>'inferred_primary_unpriced_count', '1', 'M5 is inferred from Dapper but has no dollar price');
  PERFORM _assert_eq(t->>'primary_spent_usd', '0.00', 'M4 a recorded Trade Ticket buy adds no dollars');
  PERFORM _assert_eq(t->>'primary_spend_unknown_count', '1', 'M4 counts as a primary buy of unknown dollar cost');
END $$;

-- v12 (2026-09-26): All Day judged against Dapper's drop windows; REWARD = $0.
INSERT INTO public.pack_distributions VALUES
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'QW', 'Rookie Debut Premium Wave 2', NULL, '{}'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'QR', 'Launch Codes Reward', NULL, '{"type":"REWARD"}'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'QZ', 'Jan 29 hold', NULL, '{"type":"DEFAULT"}');
INSERT INTO public.allday_pack_supply VALUES ('QW', 99), ('QR', 0), ('QZ', 0);
INSERT INTO public.allday_drop_windows (dist_id, start_time, price_usd) VALUES
  ('QW', '2024-09-06 00:00:00+00', 99), ('QR', '2025-11-07 00:00:00+00', 0), ('QZ', '2026-01-29 00:00:00+00', 0);
-- Q1 / Q2 / Q3 rips acquired inside their windows; Q4 a RECORDED primary buy of the reward drop.
INSERT INTO public.pack_rips (collection_id, pack_nft_id, opener_address, moments_pulled, sealed_at, dist_id, pull_value_usd) VALUES
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'Q1', '0xad12', 3, '2024-09-20', 'QW', 50),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'Q2', '0xad12', 3, '2025-11-20', 'QR', 5),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'Q3', '0xad12', 3, '2026-02-10', 'QZ', 5);
INSERT INTO public.pack_nft_identity VALUES
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'Q1', 'QW', 'Opened', '0xad12', now(), '2024-09-08'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'Q2', 'QR', 'Opened', '0xad12', now(), '2025-11-07'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'Q3', 'QZ', 'Opened', '0xad12', now(), '2026-01-30');
INSERT INTO public.pack_purchases (collection_id, pack_nft_id, buyer_address, seller_address, sale_price, sale_currency, sealed_at, is_primary_drop, event_kind, pack_dist_id) VALUES
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'Q4', '0xad12', '0xe4cf4bdc1751c65d', NULL, NULL, '2025-11-07', true, 'primary_withdraw', 'QR');

DO $$
DECLARE t jsonb;
BEGIN
  t := public.get_wallet_pack_summary('0xad12')->'totals';
  PERFORM _assert_eq(t->>'inferred_primary_count', '2', 'Q1 ($99, Dapper''s window) + Q2 (a reward, $0)');
  PERFORM _assert_eq(t->>'inferred_primary_spent_usd', '99.00', 'Q1 at $99; the reward adds $0');
  PERFORM _assert_eq(t->>'inferred_primary_unpriced_count', '1', 'Q3 a 0 price on a non-REWARD drop is unknown');
  PERFORM _assert_eq(t->>'primary_spend_unknown_count', '0', 'Q4 a recorded reward buy is a KNOWN $0, not an unknown');
  PERFORM _assert_eq(t->>'primary_spent_usd', '0.00', 'Q4 adds no dollars');
END $$;

ROLLBACK;
