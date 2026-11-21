-- audit_20261120_sales_leaderboard_pinnacle_skips_flow_sales
--
-- 2026-11-20 ~7:10 PM PT (Claude Code cloud; Trevor: "Keep goin").
--
-- /api/analytics/sales/leaderboard hit a statement timeout at 5:13 PM PT for role=seller, window=l30,
-- collections=pinnacle, inside a burst of ~10 parallel board calls (the page loads buyer + seller for every
-- collection). Measured: the Pinnacle window aggregation is 15 ms; the call took 3.75 s alone. The cost is
-- the is_returning probes: 'pinnacle' stayed in v_long, so for each of the top 10 addresses the function
-- probed `sales` (Flow) by address with `collection = ANY('{pinnacle}')` — which can never match (sales holds
-- 0 Pinnacle rows; Pinnacle is pinnacle_sales) — walking that address's whole sales history (~28k rows for
-- today's top 10 sellers) to prove a negative.
--
-- WHAT: 'pinnacle' is dropped from v_long; when no Flow collection remains (a Pinnacle-only board) the sales
-- leg and the sales-side is_returning probes are skipped (v_flow). Equivalence: premise `select count(*) from
-- sales where collection = 'pinnacle'` = 0, asserted below; for every other input v_long is unchanged.
--
-- PIN: supabase/tests/analytics_sales_leaderboard.sql (re-pinned to this file).
-- anon-exec: unchanged (analytics_sales_leaderboard) — CREATE OR REPLACE of an existing fn; ACL preserved (read back: postgres, service_role).
-- Revert: re-apply the body from 20261004165000_audit_20261004_sales_leaderboard_buyback_check_stays_index_only.sql
--   (prosrc md5 42351d4d6bddf8b8cdb89b08c6e00684).

DO $pre$
BEGIN
  IF EXISTS (SELECT 1 FROM public.sales WHERE collection = 'pinnacle') THEN
    RAISE EXCEPTION 'premise false: sales holds rows with collection = pinnacle';
  END IF;
END
$pre$;

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
  v_flow boolean;
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
    -- 2026-11-20: 'pinnacle' lives only in pinnacle_sales (0 rows in sales). Left in v_long it made a
    -- Pinnacle-only board walk each top address's ENTIRE sales history in the is_returning probes to prove a
    -- negative (~28k rows for the top 10 sellers; one call hit the statement timeout during a 10-board burst).
    v_long := ARRAY(SELECT x FROM unnest(v_long) AS x WHERE x <> 'pinnacle');
  END IF;
  v_flow := (v_long IS NULL OR cardinality(v_long) > 0);
  v_start := GREATEST(COALESCE(p_start_at, sales_floor), sales_floor);

  RETURN QUERY
  WITH window_sales AS (
    SELECT (CASE WHEN p_role = 'buyer' THEN s.buyer_address ELSE s.seller_address END)::text AS w_addr,
           s.price_usd, s.sold_at
    FROM sales s
    WHERE v_flow
      AND s.sold_at >= v_start
      AND (p_end_at IS NULL OR s.sold_at < p_end_at)
      AND (v_long IS NULL OR s.collection = ANY(v_long))
      AND (CASE WHEN p_role='buyer' THEN s.buyer_address ELSE s.seller_address END) IS NOT NULL
      AND (p_include_contracts OR NOT ((CASE WHEN p_role='buyer' THEN s.buyer_address ELSE s.seller_address END)::text = ANY(contract_addrs)))
      AND (p_include_contracts OR p_role <> 'buyer' OR NOT EXISTS (SELECT 1 FROM public.buyback_wallets b JOIN public.collections c ON c.id = b.collection_id WHERE c.slug = s.collection AND b.wallet_address = s.buyer_address))  -- #169: an issuer buy-back is not a buyer; a seller's sell-back proceeds still count. 2026-10-04: matched on the long-form slug (in idx_sales_*_pulse_window's key), not collection_id (not in the index), so the window read stays index-only
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
       (v_flow AND p_role = 'buyer'  AND EXISTS (SELECT 1 FROM sales s2 WHERE s2.buyer_address  = t.w_addr AND s2.sold_at >= sales_floor AND s2.sold_at < p_start_at AND (v_long IS NULL OR s2.collection = ANY(v_long))))
       OR (v_flow AND p_role = 'seller' AND EXISTS (SELECT 1 FROM sales s2 WHERE s2.seller_address = t.w_addr AND s2.sold_at >= sales_floor AND s2.sold_at < p_start_at AND (v_long IS NULL OR s2.collection = ANY(v_long))))
       OR (v_pinnacle AND p_role = 'buyer'  AND EXISTS (SELECT 1 FROM pinnacle_sales p2 WHERE p2.buyer_address  = t.w_addr AND p2.sold_at < p_start_at))
       OR (v_pinnacle AND p_role = 'seller' AND EXISTS (SELECT 1 FROM pinnacle_sales p2 WHERE p2.seller_address = t.w_addr AND p2.sold_at < p_start_at))
    )) AS is_returning,
    t.w_first_seen AS first_seen_at,
    t.w_last_seen  AS last_seen_at
  FROM top t
  ORDER BY t.w_volume_usd DESC, t.w_sale_count DESC;
END;
$function$;
