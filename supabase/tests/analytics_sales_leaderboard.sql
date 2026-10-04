-- DB invariant: public.analytics_sales_leaderboard — the buyer / seller volume board. Claims (#169):
--   1. a REGISTERED issuer buy-back wallet (buyback_wallets, per collection) is not on the BUYER board,
--      unless the caller asks for contracts (p_include_contracts) — the same switch the board's own
--      contract list uses;
--   2. the SELLER side keeps a seller's sell-back proceeds (real money to the seller);
--   3. the registry is per collection: the same address buying in a collection it is NOT registered
--      for still ranks.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261004004247_audit_20261003_buyer_signals_exclude_buyback_wallets.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.

BEGIN;

CREATE TABLE public.sales (buyer_address text, seller_address text, price_usd numeric, sold_at timestamptz,
  collection text, collection_id uuid);
CREATE TABLE public.pinnacle_sales (buyer_address text, seller_address text, sale_price_usd numeric, sold_at timestamptz);
CREATE TABLE public.buyback_wallets (collection_id uuid, wallet_address text, label text);

-- >>> BEGIN verbatim >>>
CREATE OR REPLACE FUNCTION public.analytics_sales_leaderboard(p_role text, p_start_at timestamptz DEFAULT NULL, p_end_at timestamptz DEFAULT NULL, p_collections text[] DEFAULT NULL, p_limit integer DEFAULT 25, p_min_volume numeric DEFAULT 100, p_include_contracts boolean DEFAULT false)
RETURNS TABLE(rank integer, addr text, sale_count bigint, total_volume_usd numeric, avg_price_usd numeric, is_returning boolean, first_seen_at timestamptz, last_seen_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  contract_addrs text[] := ARRAY[
    '0x3cdbb3d569211ff3',  -- NFTStorefrontV2 (Flowty fork)
    '0x4eb8a10cb9f87357',  -- NFTStorefrontV2 (Dapper)
    '0xb8ea91944fd51c43',  -- DapperOffersV2
    '0xc1e4f4f4c4257510',  -- Dapper merchant
    '0xead892083b3e2c6c',  -- DUC vault
    '0xedf9df96c92f4595',  -- Pinnacle contract
    '0x5c57f79c6694797f',  -- Flowty lending contract
    '0x0b2a3299cc857e29',  -- Top Shot contract
    '0xe4cf4bdc1751c65d',  -- AllDay contract
    '0x87ca73a41bb50ad5'   -- Golazos contract
  ];
  -- analytics_sales floors its sales leg at 2025-01-01 and carries no floor on pinnacle_sales. Preserved verbatim.
  sales_floor constant timestamptz := '2025-01-01 00:00:00+00';
  v_long text[];
  v_pinnacle boolean;
  v_start timestamptz;
BEGIN
  IF p_role NOT IN ('buyer', 'seller') THEN
    RAISE EXCEPTION 'p_role must be ''buyer'' or ''seller''';
  END IF;

  -- Push the collection filter down to sales.collection (long-form; covered by idx_sales_2026_pulse_window) instead
  -- of the CASE-mapped analytics_sales.collection, which can never be an Index Cond. Short-form names map back to
  -- long-form; 'pinnacle' selects the pinnacle_sales leg; anything else passes through unmapped like the view's ELSE.
  IF p_collections IS NULL THEN
    v_long := NULL; v_pinnacle := true;
  ELSE
    v_long := ARRAY(SELECT CASE x WHEN 'topshot' THEN 'nba_top_shot' WHEN 'allday' THEN 'nfl_all_day'
                                  WHEN 'golazos' THEN 'laliga_golazos' WHEN 'ufc' THEN 'ufc_strike' ELSE x END
                    FROM unnest(p_collections) AS x);
    v_pinnacle := ('pinnacle' = ANY(p_collections));
  END IF;
  v_start := GREATEST(COALESCE(p_start_at, sales_floor), sales_floor);

  RETURN QUERY
  WITH window_sales AS (
    SELECT (CASE WHEN p_role = 'buyer' THEN s.buyer_address ELSE s.seller_address END)::text AS w_addr,
           s.price_usd, s.sold_at
    FROM sales s
    WHERE s.sold_at >= v_start
      AND (p_end_at IS NULL OR s.sold_at < p_end_at)
      AND (v_long IS NULL OR s.collection = ANY(v_long))
      AND (CASE WHEN p_role='buyer' THEN s.buyer_address ELSE s.seller_address END) IS NOT NULL
      AND (p_include_contracts OR NOT ((CASE WHEN p_role='buyer' THEN s.buyer_address ELSE s.seller_address END)::text = ANY(contract_addrs)))
      AND (p_include_contracts OR p_role <> 'buyer' OR NOT EXISTS (SELECT 1 FROM public.buyback_wallets b WHERE b.collection_id = s.collection_id AND b.wallet_address = s.buyer_address))  -- #169: an issuer buy-back is not a buyer; a seller's sell-back proceeds still count
    UNION ALL
    SELECT (CASE WHEN p_role = 'buyer' THEN ps.buyer_address ELSE ps.seller_address END)::text,
           ps.sale_price_usd, ps.sold_at
    FROM pinnacle_sales ps
    WHERE v_pinnacle
      AND (p_start_at IS NULL OR ps.sold_at >= p_start_at)
      AND (p_end_at IS NULL OR ps.sold_at < p_end_at)
      AND (CASE WHEN p_role='buyer' THEN ps.buyer_address ELSE ps.seller_address END) IS NOT NULL
      AND (p_include_contracts OR NOT ((CASE WHEN p_role='buyer' THEN ps.buyer_address ELSE ps.seller_address END)::text = ANY(contract_addrs)))
  ),
  agg AS (
    SELECT w_addr,
           COUNT(*)::bigint                                AS w_sale_count,
           COALESCE(ROUND(SUM(price_usd)::numeric, 2), 0)  AS w_volume_usd,
           COALESCE(ROUND(AVG(price_usd)::numeric, 2), 0)  AS w_avg_price,
           MIN(sold_at)                                    AS w_first_seen,
           MAX(sold_at)                                    AS w_last_seen
    FROM window_sales
    GROUP BY w_addr
    HAVING COALESCE(SUM(price_usd), 0) >= p_min_volume
  ),
  top AS (
    SELECT a.* FROM agg a ORDER BY a.w_volume_usd DESC, a.w_sale_count DESC LIMIT p_limit
  )
  SELECT
    ROW_NUMBER() OVER (ORDER BY t.w_volume_usd DESC, t.w_sale_count DESC)::int AS rank,
    t.w_addr, t.w_sale_count, t.w_volume_usd, t.w_avg_price,
    -- is_returning: <= p_limit index probes on the address indexes, instead of a DISTINCT over every prior sale.
    (p_start_at IS NOT NULL AND (
       (p_role = 'buyer'  AND EXISTS (SELECT 1 FROM sales s2 WHERE s2.buyer_address  = t.w_addr AND s2.sold_at >= sales_floor AND s2.sold_at < p_start_at AND (v_long IS NULL OR s2.collection = ANY(v_long))))
       OR (p_role = 'seller' AND EXISTS (SELECT 1 FROM sales s2 WHERE s2.seller_address = t.w_addr AND s2.sold_at >= sales_floor AND s2.sold_at < p_start_at AND (v_long IS NULL OR s2.collection = ANY(v_long))))
       OR (v_pinnacle AND p_role = 'buyer'  AND EXISTS (SELECT 1 FROM pinnacle_sales p2 WHERE p2.buyer_address  = t.w_addr AND p2.sold_at < p_start_at))
       OR (v_pinnacle AND p_role = 'seller' AND EXISTS (SELECT 1 FROM pinnacle_sales p2 WHERE p2.seller_address = t.w_addr AND p2.sold_at < p_start_at))
    )) AS is_returning,
    t.w_first_seen AS first_seen_at,
    t.w_last_seen  AS last_seen_at
  FROM top t
  ORDER BY t.w_volume_usd DESC, t.w_sale_count DESC;
END;
$function$;

-- <<< END verbatim <<<

INSERT INTO public.buyback_wallets VALUES ('00000000-0000-0000-0000-0000000000a1', '0x00000000000000bb', 'test buy-back');
INSERT INTO public.sales VALUES
  ('0x00000000000000c1', '0x00000000000000s1', 200, now() - interval '1 day', 'nba_top_shot', '00000000-0000-0000-0000-0000000000a1'),
  ('0x00000000000000bb', '0x00000000000000s2', 500, now() - interval '1 day', 'nba_top_shot', '00000000-0000-0000-0000-0000000000a1'),
  ('0x00000000000000bb', '0x00000000000000s3', 150, now() - interval '1 day', 'nfl_all_day',  '00000000-0000-0000-0000-0000000000a2');

DO $do$
BEGIN
  PERFORM _assert_eq((SELECT string_agg(addr || ':' || total_volume_usd, ',' ORDER BY addr)
                        FROM public.analytics_sales_leaderboard('buyer', NULL, NULL, ARRAY['topshot'], 25, 100, false)),
    '0x00000000000000c1:200.00', 'the buy-back wallet is not a Top Shot buyer (claim 1)');
  PERFORM _assert_eq((SELECT string_agg(addr || ':' || total_volume_usd, ',' ORDER BY addr)
                        FROM public.analytics_sales_leaderboard('buyer', NULL, NULL, ARRAY['topshot'], 25, 100, true)),
    '0x00000000000000bb:500.00,0x00000000000000c1:200.00', 'p_include_contracts brings it back (claim 1)');
  PERFORM _assert_eq((SELECT string_agg(addr || ':' || total_volume_usd, ',' ORDER BY addr)
                        FROM public.analytics_sales_leaderboard('seller', NULL, NULL, ARRAY['topshot'], 25, 100, false)),
    '0x00000000000000s1:200.00,0x00000000000000s2:500.00', 'a seller''s sell-back proceeds still count (claim 2)');
  PERFORM _assert_eq((SELECT string_agg(addr || ':' || total_volume_usd, ',' ORDER BY addr)
                        FROM public.analytics_sales_leaderboard('buyer', NULL, NULL, ARRAY['allday'], 25, 100, false)),
    '0x00000000000000bb:150.00', 'registered for Top Shot only, it still ranks in All Day (claim 3)');
END
$do$;

ROLLBACK;
