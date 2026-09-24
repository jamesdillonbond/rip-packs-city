-- audit_20260924_pack_market_sales_from_onchain_sales_not_the_studio_subset
--
-- WHAT WAS WRONG (measured 2026-09-24 ~5:30 AM PT): the pack-page market row
-- (sales counts, 90-day median/avg, last sale, all-time min/max) was built
-- ONLY from Dapper's studio index (`topshot_pack_sales_history` /
-- `allday_pack_sales_history`). That index carries ONLY `custom_id =
-- 'DAPPER_MARKETPLACE'` sales. The on-chain feed `pack_purchases`
-- (event_kind 'secondary_sale') has every sale:
--   * Top Shot, one settled day (5–6 days ago): 894 on-chain sales, 373 in the
--     studio index (42%); the missing 521 all carry custom_id 'nba'.
--   * dist 8552: 8,956 on-chain sales in 90 days; the cache said 75, with a
--     90-day median of $17.00 against the on-chain $9.00. Last sale shown
--     2026-09-03 while the pack last sold 2026-09-21.
-- And the studio row's `block_time` / `tx_hash` are the LISTING's, not the
-- sale's (300/300 matched listing id + price; the chain sale is a median
-- 9 min later, p90 ~8 days later), so "last sale at" read a listing time.
--
-- FIX: one helper, `pack_market_sales_stats(collection, dist)`, reads
--   * `pack_purchases` secondary sales (complete since 2026-04-10 Top Shot /
--     2026-04-24 All Day, 100% dist-named), timestamped at the SALE; plus
--   * studio rows LISTED before the on-chain feed began, when no on-chain
--     row shares their (pack_nft_id, listing_resource_id) — the only source
--     of pre-April history, so all-time n/min/max keep it.
-- `refresh_pack_market_sales_cache` and `get_pack_market_row`'s cache-miss
-- path both call it; the cache-hit path is unchanged. Cost on the busiest
-- dist (8552, 10,423 rows): 99.8 ms, 1,712 buffers (EXPLAIN ANALYZE).
--
-- Every Top Shot / All Day cache row whose dist has an on-chain secondary sale
-- is re-stamped to 1970-01-01 so the stalest-first walk refreshes those first
-- (still a cache HIT — `> '-infinity'` — so pages keep serving from cache).
--
-- anon-exec: NOT granted — pack_market_sales_stats is SECURITY INVOKER and
-- REVOKEd below from PUBLIC/anon/authenticated (its callers are a SECDEF RPC
-- and a pg_cron job); refresh_pack_market_sales_cache and get_pack_market_row
-- keep their signatures, so CREATE OR REPLACE preserves their ACLs (anon and
-- authenticated EXECUTE both read FALSE live 2026-09-24).
--
-- anon-exec: intentional — CREATE OR REPLACE of an existing signature keeps its live ACL (anon/authenticated EXECUTE false, service_role true, checked 2026-09-24); a REVOKE here would change nothing (refresh_pack_market_sales_cache)
-- anon-exec: intentional — CREATE OR REPLACE of an existing SECURITY DEFINER signature keeps its live ACL (anon/authenticated EXECUTE false, checked 2026-09-24) (get_pack_market_row)
--
-- REVERT: re-apply the bodies from
--   20260919180521 (refresh_pack_market_sales_cache) and
--   20260919180751 (get_pack_market_row), then
--   DROP FUNCTION public.pack_market_sales_stats(uuid, text);

CREATE OR REPLACE FUNCTION public.pack_market_sales_stats(p_collection_id uuid, p_dist_id text)
 RETURNS TABLE(n_sales bigint, n_sales_30d bigint, n_sales_90d bigint, avg_price_90d numeric,
               median_price_90d numeric, min_price_all numeric, max_price_all numeric,
               last_sale_price numeric, last_sale_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH chain AS (
    SELECT p.sale_price AS price, p.sealed_at AS at
      FROM public.pack_purchases p
     WHERE p.collection_id = p_collection_id
       AND p.pack_dist_id = p_dist_id
       AND p.event_kind = 'secondary_sale'
       AND p.sale_price > 0
  ), studio_pre AS (
    SELECT h.sale_price_usd AS price, h.block_time AS at
      FROM public.topshot_pack_sales_history h
     WHERE p_collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
       AND h.dist_id = p_dist_id AND h.purchased AND h.sale_price_usd > 0
       AND h.block_time < '2026-04-10'::timestamptz
       AND NOT EXISTS (SELECT 1 FROM public.pack_purchases pp
                        WHERE pp.pack_nft_id = h.pack_nft_id
                          AND pp.listing_resource_id = h.listing_resource_id
                          AND pp.event_kind = 'secondary_sale')
    UNION ALL
    SELECT h.sale_price_usd, h.block_time
      FROM public.allday_pack_sales_history h
     WHERE p_collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
       AND h.dist_id = p_dist_id AND h.purchased AND h.sale_price_usd > 0
       AND h.block_time < '2026-04-24'::timestamptz
       AND NOT EXISTS (SELECT 1 FROM public.pack_purchases pp
                        WHERE pp.pack_nft_id = h.pack_nft_id
                          AND pp.listing_resource_id = h.listing_resource_id
                          AND pp.event_kind = 'secondary_sale')
  ), a AS (
    SELECT price, at FROM chain
    UNION ALL
    SELECT price, at FROM studio_pre
  )
  SELECT count(*),
         count(*) FILTER (WHERE a.at > now() - interval '30 days'),
         count(*) FILTER (WHERE a.at > now() - interval '90 days'),
         round(avg(a.price) FILTER (WHERE a.at > now() - interval '90 days'), 2),
         round((percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY a.price::double precision)
                FILTER (WHERE a.at > now() - interval '90 days'))::numeric, 2),
         round(min(a.price), 2),
         round(max(a.price), 2),
         round((array_agg(a.price ORDER BY a.at DESC))[1], 2),
         max(a.at)
    FROM a;
$function$;

COMMENT ON FUNCTION public.pack_market_sales_stats(uuid, text) IS
  'Pack-page market stats for one Top Shot / All Day dist: on-chain pack_purchases secondary sales (every marketplace, sale-timestamped) plus studio-index rows listed before the on-chain feed began. The studio index alone carries only DAPPER_MARKETPLACE sales (42% of Top Shot). 2026-09-24.';

REVOKE ALL ON FUNCTION public.pack_market_sales_stats(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pack_market_sales_stats(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_pack_market_sales_cache(p_dists integer DEFAULT 40, p_soft_deadline_s integer DEFAULT 45)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started  timestamptz := clock_timestamp();
  v_ts_id    uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_ad_id    uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_seeded   int := 0;
  v_done     int := 0;
  v_deadline boolean := false;
  r          record;
BEGIN
  -- 1. Roster: every known dist gets a row, stamped -infinity so it sorts first.
  INSERT INTO public.pack_market_sales_cache
    (collection_id, dist_id, n_sales, n_sales_30d, n_sales_90d, computed_at)
  SELECT pd.collection_id, pd.dist_id, 0, 0, 0, '-infinity'::timestamptz
  FROM public.pack_distributions pd
  WHERE pd.collection_id IN (v_ts_id, v_ad_id)
  ON CONFLICT (collection_id, dist_id) DO NOTHING;
  GET DIAGNOSTICS v_seeded = ROW_COUNT;

  -- 2. Walk the stalest slice. Stats come from pack_market_sales_stats():
  --    on-chain sales + pre-feed studio history (2026-09-24).
  FOR r IN
    SELECT c.collection_id, c.dist_id
    FROM public.pack_market_sales_cache c
    WHERE c.collection_id IN (v_ts_id, v_ad_id)
    ORDER BY c.computed_at ASC, c.dist_id ASC
    LIMIT p_dists
  LOOP
    IF extract(epoch FROM (clock_timestamp() - v_started)) > p_soft_deadline_s THEN
      v_deadline := true;
      EXIT;
    END IF;

    UPDATE public.pack_market_sales_cache c SET
      n_sales = s.n_sales, n_sales_30d = s.n_sales_30d, n_sales_90d = s.n_sales_90d,
      avg_price_90d = s.avg_price_90d, median_price_90d = s.median_price_90d,
      min_price_all = s.min_price_all, max_price_all = s.max_price_all,
      last_sale_price = s.last_sale_price, last_sale_at = s.last_sale_at,
      computed_at = now()
    FROM public.pack_market_sales_stats(r.collection_id, r.dist_id) s
    WHERE c.collection_id = r.collection_id AND c.dist_id = r.dist_id;

    v_done := v_done + 1;
  END LOOP;

  INSERT INTO public.pipeline_runs
    (pipeline, started_at, finished_at, rows_found, rows_written, ok, extra)
  VALUES ('pack-market-sales-cache-refresh', v_started, clock_timestamp(),
          v_done, v_done, true,
          jsonb_build_object(
            'dists_refreshed',   v_done,
            'roster_seeded',     v_seeded,
            'slice_limit',       p_dists,
            'soft_deadline_s',   p_soft_deadline_s,
            'hit_soft_deadline', v_deadline,
            'source',            'pack_market_sales_stats',
            'duration_ms',       (extract(epoch FROM (clock_timestamp() - v_started)) * 1000)::int,
            'stalest_remaining', (SELECT count(*) FROM public.pack_market_sales_cache
                                   WHERE computed_at < now() - interval '6 hours')
          ));

  RETURN jsonb_build_object('dists_refreshed', v_done, 'roster_seeded', v_seeded,
                            'hit_soft_deadline', v_deadline);
END;
$function$;

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

  -- ── CACHE MISS: the same stats the cache holds, computed live (2026-09-24:
  --    on-chain sales + pre-feed studio history, via pack_market_sales_stats).
  RETURN QUERY
  WITH s AS (
    SELECT * FROM public.pack_market_sales_stats(v_coll, p_dist_id)
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
END;
$function$;

-- Re-queue every dist with an on-chain sale to the front of the stalest-first walk.
UPDATE public.pack_market_sales_cache c
   SET computed_at = '1970-01-01'::timestamptz
 WHERE c.computed_at > '-infinity'::timestamptz
   AND EXISTS (SELECT 1 FROM public.pack_purchases p
                WHERE p.collection_id = c.collection_id
                  AND p.pack_dist_id = c.dist_id
                  AND p.event_kind = 'secondary_sale');
