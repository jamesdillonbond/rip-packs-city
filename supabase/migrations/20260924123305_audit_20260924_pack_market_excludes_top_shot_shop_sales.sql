-- audit_20260924_pack_market_excludes_top_shot_shop_sales
--
-- ⛔ CORRECTS 20260924122325 / 122704 / 122827 (applied ~40 min earlier the same
-- morning). Those migrations moved pack-market stats onto pack_purchases
-- secondary sales on the premise that the studio index "misses 58% of Top Shot
-- pack sales". The missing rows are NOT secondary sales. Measured right after:
--   custom_id 'nba' (34,062 Top Shot rows, all time): ONE storefront
--   (250688653852667), ONE seller, and a single fixed price per dist on 125 of
--   139 dists — Top Shot's own shop selling packs (e.g. dist 8642 at $5.00 on
--   350 of 350 sales, dist 8552 at $9.00). DAPPER_MARKETPLACE (76,176 rows):
--   1,907 storefronts, 1,660 sellers, prices vary — the collector market.
-- The studio index holds exactly the DAPPER_MARKETPLACE rows (373 of 373 on the
-- settled day tested), so it was COMPLETE for the secondary market. Counting
-- the shop inflated 90-day counts (dist 8552: 8,956 vs the true secondary
-- count) and pulled medians to the shop price (8642: $5.00 vs $5.74).
--
-- FIX: pack_market_sales_stats() and get_pack_metrics() exclude custom_id
-- 'nba' from the on-chain source. What the chain source still adds over the
-- studio index, and why it stays: sale-time timestamps (the studio row carries
-- the LISTING's time and tx) and freshness (ingested a median ~7 min after the
-- sale vs ~80 min for the studio index). pack_purchases still classes the shop
-- rows as event_kind 'secondary_sale' — filed for the ingest, not changed here.
--
-- anon-exec: intentional — CREATE OR REPLACE of the existing signature keeps its ACL (REVOKEd from PUBLIC/anon/authenticated in 20260924122704; checked false 2026-09-24) (pack_market_sales_stats)
-- anon-exec: intentional — CREATE OR REPLACE (via the asserted replace below) of the existing signature keeps its ACL (anon/authenticated EXECUTE false, checked 2026-09-24) (get_pack_metrics)
--
-- REVERT: re-apply the pack_market_sales_stats body from 20260924122704 and the
-- inverse of the get_pack_metrics replace below.

CREATE OR REPLACE FUNCTION public.pack_market_sales_stats(p_collection_id uuid, p_dist_id text)
 RETURNS TABLE(n_sales bigint, n_sales_30d bigint, n_sales_90d bigint, avg_price_90d numeric,
               median_price_90d numeric, min_price_all numeric, max_price_all numeric,
               last_sale_price numeric, last_sale_at timestamp with time zone,
               first_sale_at timestamp with time zone)
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
       -- Top Shot's own shop (one storefront, fixed price per dist) is not the secondary market.
       AND p.custom_id IS DISTINCT FROM 'nba'
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
         max(a.at),
         min(a.at)
    FROM a;
$function$;

COMMENT ON FUNCTION public.pack_market_sales_stats(uuid, text) IS
  'Secondary-market pack stats for one Top Shot / All Day dist: on-chain pack_purchases secondary sales EXCLUDING Top Shot''s own shop (custom_id ''nba'': one storefront, fixed price) — sale-timestamped, ingested minutes after the sale — plus studio-index rows listed before the on-chain feed began. Feeds pack_market_sales_cache → get_pack_market_row and mv_*_pack_sales_agg. 2026-09-24.';

DO $mig$
DECLARE
  v_src text;
  v_new text;
  old_ts text := $o1$     WHERE p.collection_id = v_ts AND p.event_kind = 'secondary_sale' AND p.sealed_at > now() - interval '8 days'$o1$;
  new_ts text := $n1$     WHERE p.collection_id = v_ts AND p.event_kind = 'secondary_sale' AND p.sealed_at > now() - interval '8 days'
       AND p.custom_id IS DISTINCT FROM 'nba'$n1$;
BEGIN
  SELECT prosrc INTO STRICT v_src FROM pg_proc WHERE oid = 'public.get_pack_metrics()'::regprocedure;
  IF (length(v_src) - length(replace(v_src, old_ts, ''))) / length(old_ts) <> 1 THEN
    RAISE EXCEPTION 'get_pack_metrics: Top Shot on-chain sales filter not found exactly once';
  END IF;
  v_new := replace(v_src, old_ts, new_ts);
  EXECUTE format($f$CREATE OR REPLACE FUNCTION public.get_pack_metrics()
RETURNS %s
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS %L$f$, pg_get_function_result('public.get_pack_metrics()'::regprocedure), v_new);
END
$mig$;

-- Re-queue every row with sales so the next refresh recomputes it without the shop.
UPDATE public.pack_market_sales_cache SET computed_at = '1970-01-01'::timestamptz
 WHERE computed_at > '-infinity'::timestamptz AND n_sales > 0;
