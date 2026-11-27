-- 2026-11-26 (Claude Code cloud, autonomous pass). get_pack_market_row (the pack page's "Sealed pack resale"
-- panel) reads the pack's DROP price as retail, not today's lowest secondary ask. Same defect, same fix as
-- 20261127005234 (v_topshot_pack_market), in the per-page reader.
--
-- WHY. retail_price came from mv_pack_ev_latest.pack_price, which is the secondary ask for every Top Shot dist
-- (price_source 'secondary', primary NULL, 1,852 of 1,852 on 11-26). Live: /nba-top-shot/pack/dist/8596, a
-- case topper with no standalone retail ("No standalone retail price" in the page's own header), read
-- "Retail $209 · trades 1.20x retail — secondary premium"; $209 was the lowest ask. The All Day leg read the
-- same MV, while the All Day board reads allday_pack_supply.pack_price.
--
-- NOW. Top Shot: pack_distributions.metadata.retail_price_usd normalized exactly as pack_table_rows does (a value
-- >= 1,000,000 is a UFix64 x1e8). All Day: allday_pack_supply.pack_price, the All Day board's source. 0 (no
-- standalone retail) and holding-pack sentinels (>= 9,999) are NULL, so the page prints no retail and no
-- verdict (it already hides both on NULL). Sales half, cache hit/miss logic, signature, RETURNS, STABLE,
-- SECURITY DEFINER and search_path are unchanged.
--
-- anon-exec: intentional — CREATE OR REPLACE of an existing signature keeps its live ACL (postgres + service_role only; anon/authenticated EXECUTE false, read 11-26) (get_pack_market_row)
--
-- REVERT: CREATE OR REPLACE get_pack_market_row from 20260924122704 (retail_price := mv_pack_ev_latest.pack_price).
CREATE OR REPLACE FUNCTION public.get_pack_market_row(p_collection_slug text, p_dist_id text)
 RETURNS TABLE(n_sales bigint, n_sales_30d bigint, n_sales_90d bigint, last_sale_price numeric, last_sale_at timestamp with time zone, avg_price_90d numeric, median_price_90d numeric, min_price_all numeric, max_price_all numeric, retail_price numeric, secondary_vs_retail_ratio numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_coll   uuid;
  v_hit    boolean := false;
  v_raw    numeric;
  v_retail numeric;
BEGIN
  IF p_collection_slug = 'nba-top-shot' THEN
    v_coll := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
    SELECT CASE
             WHEN (d.metadata ->> 'retail_price_usd') IS NULL THEN NULL::numeric
             WHEN (d.metadata ->> 'retail_price_usd')::numeric >= 1000000 THEN round((d.metadata ->> 'retail_price_usd')::numeric / 100000000, 2)
             ELSE round((d.metadata ->> 'retail_price_usd')::numeric, 2)
           END
      INTO v_raw
      FROM public.pack_distributions d
     WHERE d.collection_id = v_coll AND d.dist_id = p_dist_id
     LIMIT 1;
  ELSIF p_collection_slug = 'nfl-all-day' THEN
    v_coll := 'dee28451-5d62-409e-a1ad-a83f763ac070';
    SELECT sup.pack_price INTO v_raw
      FROM public.allday_pack_supply sup
     WHERE sup.dist_id = p_dist_id
     LIMIT 1;
  ELSE
    RETURN;
  END IF;

  -- 0 = no standalone retail (reward, box and case packs); >= 9,999 = holding-pack sentinel.
  v_retail := CASE WHEN v_raw > 0 AND v_raw < 9999 THEN v_raw END;

  -- A seeded-but-uncomputed roster row is NOT a hit. See the header.
  SELECT true INTO v_hit
  FROM public.pack_market_sales_cache c
  WHERE c.collection_id = v_coll
    AND c.dist_id = p_dist_id
    AND c.computed_at > '-infinity'::timestamptz;

  IF coalesce(v_hit, false) THEN
    RETURN QUERY
    WITH s AS (
      SELECT c.n_sales, c.n_sales_30d, c.n_sales_90d, c.avg_price_90d,
             c.median_price_90d, c.min_price_all, c.max_price_all,
             c.last_sale_price, c.last_sale_at
      FROM public.pack_market_sales_cache c
      WHERE c.collection_id = v_coll AND c.dist_id = p_dist_id
    )
    SELECT s.n_sales, s.n_sales_30d, s.n_sales_90d, s.last_sale_price, s.last_sale_at,
           s.avg_price_90d, s.median_price_90d, s.min_price_all, s.max_price_all,
           v_retail,
           CASE WHEN v_retail > 0 AND s.median_price_90d IS NOT NULL
                THEN round(s.median_price_90d / v_retail, 2) END
    FROM s
    WHERE s.n_sales > 0;
    RETURN;
  END IF;

  -- ── CACHE MISS: the same stats the cache holds, computed live (2026-09-24:
  --    on-chain sales + pre-feed studio history, via pack_market_sales_stats).
  RETURN QUERY
  WITH s AS (
    SELECT * FROM public.pack_market_sales_stats(v_coll, p_dist_id)
  )
  SELECT s.n_sales, s.n_sales_30d, s.n_sales_90d, s.last_sale_price, s.last_sale_at,
         s.avg_price_90d, s.median_price_90d, s.min_price_all, s.max_price_all,
         v_retail,
         CASE WHEN v_retail > 0 AND s.median_price_90d IS NOT NULL
              THEN round(s.median_price_90d / v_retail, 2) END
  FROM s
  WHERE s.n_sales > 0;
END;
$function$;
