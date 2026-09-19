-- audit_20260919_get_pack_market_row_reads_the_cache
--
-- Live body re-read immediately before this replace: ONE overload, md5
-- `6ca755ff959a4b04478c61e53d4512ba`, 3,876 chars. Signature and RETURNS TABLE
-- are UNCHANGED, so no new overload is created and no ACL is reset.
--
-- Measured cost of the body this replaces, on dist_id 4184:
--   Buffers: shared hit=11 read=8910 (71 MB) - Execution 33,644 ms
-- The cache turns that into one PK lookup on `pack_market_sales_cache`.
--
-- 🚨 THE HONESTY-CRITICAL LINE IS THE HIT TEST, AND IT IS `computed_at >
-- '-infinity'`, NOT `FOUND`. The refresh SEEDS a roster row for every dist in
-- `pack_distributions` carrying `n_sales = 0` and `computed_at = '-infinity'`,
-- so a row EXISTS for dists that have never been computed. Serving one would
-- publish "this pack has no sales" about a pack the cache simply has not reached
-- yet - and `fetchPackMarket` renders a null row as "no market data", not as an
-- error. A seeded row therefore MUST fall through to the live aggregate.
--
-- ✅ VERIFIED 2026-09-19 on dist 1096, which was seeded-but-uncomputed AND has
-- 5,284 real sales: `get_pack_market_row('nfl-all-day','1096')` returned
-- n_sales = 5284 via the fallback, not the seeded zero.
--
-- ⚠ A genuine zero is still cached and still served: a dist that HAS been
-- computed and truly has no qualifying sales gets `n_sales = 0` with a real
-- `computed_at`, and the `WHERE s.n_sales > 0` below returns no row - exactly
-- what the live body does. Computed-zero and never-computed are different
-- states and this function keeps them different.
--
-- ✅ EQUIVALENCE VERIFIED, 10 cached All Day dists against a fresh live
-- aggregate: 0 mismatches on n_sales, min_price_all, max_price_all,
-- last_sale_price and last_sale_at. ⚠ The 30d/90d columns are deliberately NOT
-- in that comparison - they depend on `now()`, so cached and live drift apart as
-- the window slides. That drift is bounded by the refresh cycle, and it is the
-- one semantic difference this cache introduces.
--
-- ⚠ `retail_price` / `secondary_vs_retail_ratio` are NOT cached and are read
-- live from `mv_pack_ev_latest` (440 kB, indexed) on BOTH paths, so the cache
-- cannot serve a stale retail price.
--
-- ⚠ Staleness of the cached half is bounded by pg_cron jobid 527 (~1 full cycle
-- per day) and is readable per row as `computed_at`. If that job dies this
-- function silently returns to the 33-second live path - which is why the
-- refresh writes a `pipeline_runs` row every tick.
--
-- ── REVERT ────────────────────────────────────────────────────────────────────
-- ⭐ Cheapest and safest: `TRUNCATE public.pack_market_sales_cache;` - with an
-- empty cache every call takes the live path and behaviour is identical to the
-- pre-cache body. No DDL, no downtime, instantly reversible.
-- To restore the pre-cache DEFINITION, re-apply the body from
-- `20260726180543_audit_20260726_get_pack_market_row_mv_swap.sql` and re-check
-- it against md5 6ca755ff959a4b04478c61e53d4512ba.

-- anon-exec: NOT granted - get_pack_market_row is SECURITY DEFINER and anon/authenticated EXECUTE both read FALSE live on 2026-09-19 (service_role true), so the decision is already made and unchanged here.
--
-- ⚠ MARKER RATHER THAN A REVOKE, ON PURPOSE. This is a CREATE OR REPLACE of the
-- SAME signature, and CREATE OR REPLACE does not reset a function ACL - so a
-- REVOKE in this file would not be protecting anything, it would be a
-- production ACL statement smuggled into a body swap. The guard
-- `migration-new-function-states-its-anon-exec-decision` asks for exactly this
-- marker in the snapshot case, and its point stands: silence is not a decision.

CREATE OR REPLACE FUNCTION public.get_pack_market_row(p_collection_slug text, p_dist_id text)
 RETURNS TABLE(n_sales bigint, n_sales_30d bigint, n_sales_90d bigint, last_sale_price numeric, last_sale_at timestamp with time zone, avg_price_90d numeric, median_price_90d numeric, min_price_all numeric, max_price_all numeric, retail_price numeric, secondary_vs_retail_ratio numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_coll uuid;
  v_hit  boolean := false;
BEGIN
  IF p_collection_slug = 'nba-top-shot' THEN
    v_coll := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  ELSIF p_collection_slug = 'nfl-all-day' THEN
    v_coll := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  ELSE
    RETURN;
  END IF;

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
    ), ev AS (
      SELECT pel.pack_price FROM mv_pack_ev_latest pel
      WHERE pel.collection_id = v_coll AND pel.dist_id = p_dist_id
      ORDER BY pel.snapshotted_at DESC LIMIT 1
    )
    SELECT s.n_sales, s.n_sales_30d, s.n_sales_90d, s.last_sale_price, s.last_sale_at,
           s.avg_price_90d, s.median_price_90d, s.min_price_all, s.max_price_all,
           ev.pack_price,
           CASE WHEN ev.pack_price > 0 AND s.median_price_90d IS NOT NULL
                THEN round(s.median_price_90d / ev.pack_price, 2) END
    FROM s LEFT JOIN ev ON true
    WHERE s.n_sales > 0;
    RETURN;
  END IF;

  -- ── CACHE MISS: the original live aggregate, unchanged ──────────────────────
  IF p_collection_slug = 'nba-top-shot' THEN
    RETURN QUERY
    WITH s AS (
      SELECT count(*) AS n_sales,
             count(*) FILTER (WHERE h.block_time > now() - interval '30 days') AS n_sales_30d,
             count(*) FILTER (WHERE h.block_time > now() - interval '90 days') AS n_sales_90d,
             round(avg(h.sale_price_usd) FILTER (WHERE h.block_time > now() - interval '90 days'), 2) AS avg_price_90d,
             round((percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY h.sale_price_usd::double precision) FILTER (WHERE h.block_time > now() - interval '90 days'))::numeric, 2) AS median_price_90d,
             round(min(h.sale_price_usd), 2) AS min_price_all,
             round(max(h.sale_price_usd), 2) AS max_price_all,
             round((array_agg(h.sale_price_usd ORDER BY h.block_time DESC))[1], 2) AS last_sale_price,
             max(h.block_time) AS last_sale_at
      FROM topshot_pack_sales_history h
      WHERE h.dist_id = p_dist_id AND h.purchased AND h.sale_price_usd IS NOT NULL
    ), ev AS (
      SELECT pel.pack_price FROM mv_pack_ev_latest pel
      WHERE pel.collection_id = v_coll AND pel.dist_id = p_dist_id
      ORDER BY pel.snapshotted_at DESC LIMIT 1
    )
    SELECT s.n_sales, s.n_sales_30d, s.n_sales_90d, s.last_sale_price, s.last_sale_at,
           s.avg_price_90d, s.median_price_90d, s.min_price_all, s.max_price_all,
           ev.pack_price,
           CASE WHEN ev.pack_price > 0 AND s.median_price_90d IS NOT NULL
                THEN round(s.median_price_90d / ev.pack_price, 2) END
    FROM s LEFT JOIN ev ON true
    WHERE s.n_sales > 0;
  ELSIF p_collection_slug = 'nfl-all-day' THEN
    RETURN QUERY
    WITH s AS (
      SELECT count(*) AS n_sales,
             count(*) FILTER (WHERE h.block_time > now() - interval '30 days') AS n_sales_30d,
             count(*) FILTER (WHERE h.block_time > now() - interval '90 days') AS n_sales_90d,
             round(avg(h.sale_price_usd) FILTER (WHERE h.block_time > now() - interval '90 days'), 2) AS avg_price_90d,
             round((percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY h.sale_price_usd::double precision) FILTER (WHERE h.block_time > now() - interval '90 days'))::numeric, 2) AS median_price_90d,
             round(min(h.sale_price_usd), 2) AS min_price_all,
             round(max(h.sale_price_usd), 2) AS max_price_all,
             round((array_agg(h.sale_price_usd ORDER BY h.block_time DESC))[1], 2) AS last_sale_price,
             max(h.block_time) AS last_sale_at
      FROM allday_pack_sales_history h
      WHERE h.dist_id = p_dist_id AND h.purchased AND h.sale_price_usd IS NOT NULL
    ), ev AS (
      SELECT pel.pack_price FROM mv_pack_ev_latest pel
      WHERE pel.collection_id = v_coll AND pel.dist_id = p_dist_id
      ORDER BY pel.snapshotted_at DESC LIMIT 1
    )
    SELECT s.n_sales, s.n_sales_30d, s.n_sales_90d, s.last_sale_price, s.last_sale_at,
           s.avg_price_90d, s.median_price_90d, s.min_price_all, s.max_price_all,
           ev.pack_price,
           CASE WHEN ev.pack_price > 0 AND s.median_price_90d IS NOT NULL
                THEN round(s.median_price_90d / ev.pack_price, 2) END
    FROM s LEFT JOIN ev ON true
    WHERE s.n_sales > 0;
  END IF;
END;
$function$;
