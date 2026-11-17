-- 2026-10-04 (PT) — analytics_sales_leaderboard: the #169 buy-back exclusion matches on the
-- long-form collection slug, so the window read stays index-only.
--
-- WHY. Vercel, 6 h to ~9:35 AM PT 10-04: `/api/analytics/sales/leaderboard` returned 500
-- `canceling statement due to statement timeout` 9 times (buyer board, l30, Top Shot / All Day /
-- Pinnacle), mostly on the first cold call after a deploy. Cold, the function took 10.1 s and
-- 57.7 k buffers (18.4 k read). The #169 clause (20261004004247), "the buyer is not a registry
-- buy-back wallet", joins `b.collection_id = s.collection_id`. collection_id is NOT in
-- idx_sales_*_pulse_window (collection, sold_at DESC) INCLUDE (price_usd, buyer_address,
-- seller_address), so every window row became a heap fetch: an Index Scan, 55.5 k buffers for the
-- 30-day Top Shot window, against an Index Only Scan before #169.
--
-- WHAT. The same predicate, matched on `c.slug = s.collection` through collections (long-form
-- slug, in the index key). Equivalence: of 399,771 sales since 2025-01-01 bought by the three
-- buy-back wallets, 0 have a `sales.collection` that differs from their collection_id's slug.
-- Nothing else changes.
--
-- MEASURED (same query shape, 30-day Top Shot buyer window): 55,508 -> ~10.9 k buffers,
-- Index Only Scan, same 391 rows. Post-apply numbers: see the ledger entry of 2026-10-04.
-- anon-exec: unchanged (analytics_sales_leaderboard) — CREATE OR REPLACE of an existing fn; ACL preserved.
--
-- Revert: re-apply the analytics_sales_leaderboard block from
--   supabase/migrations/20261004004247_audit_20261003_buyer_signals_exclude_buyback_wallets.sql
-- and repoint the pin (supabase/tests/analytics_sales_leaderboard.sql, db-invariants-drift-guard).

DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.analytics_sales_leaderboard(text,timestamptz,timestamptz,text[],integer,numeric,boolean)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '0ead35a2cbbb772a214af7b8f6d6cf91' THEN
    RAISE EXCEPTION 'analytics_sales_leaderboard changed since the splice base (live md5 %) -- re-splice', v_md5;
  END IF;
END
$guard$;

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
