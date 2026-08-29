-- audit_20260829_leaderboard_collection_pushdown_and_per_row_returning_probe
--
-- WHY: /api/analytics/sales/leaderboard served 500s on 30 of 40 sweep requests over 24h (08-29). Measured
-- against prod as postgres (no statement_timeout): the ufc call returned 0 rows for 41,361 buffers / 25.8 s and
-- the topshot call 162,717 buffers + 6,665 temp blocks / 43.6 s, against service_role's 30 s ceiling.
-- Two mechanisms, both visible in one plan:
--   (1) the collection predicate went through analytics_sales' CASE-mapped `collection`, which can never be an
--       Index Cond -> every partition row in the window was read and filtered (456k + 725k rows removed for 3 rows);
--   (2) `prior_addrs` computed DISTINCT over every prior sale in the collection (unbounded back to 2025-01-01)
--       to set a boolean on <= p_limit rows.
-- FIX: query the base tables directly. Short-form names are mapped back to the long-form `sales.collection`
-- (which idx_sales_2026_pulse_window covers: Index Only Scan), Pinnacle stays on pinnacle_sales, and anything
-- else (candy_mlb, ...) passes through unmapped exactly like the view's ELSE branch. `is_returning` becomes a
-- per-row EXISTS on the buyer/seller address indexes. Semantics preserved verbatim: the 2025-01-01 floor on the
-- sales leg, no floor on pinnacle_sales, the contract-address exclusion, HAVING on p_min_volume, ordering + rank.
-- MEASURED (same instance, same afternoon): ufc  41,361 -> 2,194 buffers, 25.8 s -> 59 ms;
--                                            topshot 162,717(+6,665 temp) -> 27,642 buffers, 43.6 s -> 11.6 s.
-- EQUALITY: old EXCEPT new = 0 and new EXCEPT old = 0 on (seller,l7,allday), (buyer,l30,pinnacle+candy_mlb,
-- include_contracts=true), (buyer,l30,topshot) — is_returning included in the row comparison (9/10 true).
-- Same signature -> ACLs preserved (anon/authenticated EXECUTE were false before; re-verified after).
-- anon-exec: intentional — same signature, ACLs unchanged, SECURITY DEFINER read-only leaderboard (analytics_sales_leaderboard)
--
-- REVERT: re-create the function with the prior body (it reads analytics_sales with
--   `(p_collections IS NULL OR s.collection = ANY(p_collections))` in window_sales and a
--   `prior_addrs AS (SELECT DISTINCT ... FROM analytics_sales WHERE sold_at < p_start_at ...)` LEFT JOIN).
--   The prior definition is recorded verbatim in docs/overnight/ledger.md under this date, and the function
--   body before this migration is in the Project doc claude/leaderboard-prior-body-2026-08-29.sql.

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

DROP FUNCTION IF EXISTS public._scratch_lb_v2(text, timestamptz, timestamptz, text[], integer, numeric, boolean);