-- audit_20260922_ghost_listings_refresh_inlines_the_collection_literal
--
-- Follow-up to 20260922205752 (same session, ~2:15 PM PT). The first pg_cron run of
-- refresh_allday_listings_sold_after_listing() (job 596, 2:07 PM PT) took 18.5 s and a
-- manual call 8.5 s, while the SAME insert-select with the collection id as a LITERAL
-- measured 1.75 s (EXPLAIN ANALYZE, 105k buffers). The only difference is the plpgsql
-- variable v_coll: a parameter hides the constant from the planner at the partitioned
-- `sales` probe. This body is identical except that the collection id is inlined.
--
-- REVERT: re-apply the function body from 20260922205752 (it is correct, only slower).

CREATE OR REPLACE FUNCTION public.refresh_allday_listings_sold_after_listing()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_start    timestamptz := clock_timestamp();
  v_inserted int := 0;
  v_pruned   int := 0;
  v_total    int := 0;
BEGIN
  INSERT INTO public.allday_listings_sold_after_listing (listing_resource_id, source, flow_id, listed_at)
  SELECT cl.listing_resource_id, cl.source, cl.flow_id, cl.listed_at
  FROM public.cached_listings_v2 cl
  WHERE cl.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
    AND cl.completed_at IS NULL
    AND cl.listed_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.allday_listings_sold_after_listing g
                    WHERE g.listing_resource_id = cl.listing_resource_id AND g.source = cl.source)
    AND EXISTS (SELECT 1 FROM public.sales s
                WHERE s.nft_id = cl.flow_id::text
                  AND s.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
                  AND s.sold_at > cl.listed_at)
  ON CONFLICT (listing_resource_id, source) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  DELETE FROM public.allday_listings_sold_after_listing g
  WHERE NOT EXISTS (SELECT 1 FROM public.cached_listings_v2 cl
                    WHERE cl.listing_resource_id = g.listing_resource_id
                      AND cl.source = g.source
                      AND cl.completed_at IS NULL);
  GET DIAGNOSTICS v_pruned = ROW_COUNT;

  SELECT count(*) INTO v_total FROM public.allday_listings_sold_after_listing;

  RETURN jsonb_build_object('inserted', v_inserted, 'pruned', v_pruned, 'total', v_total,
                            'ms', round(extract(epoch FROM clock_timestamp() - v_start) * 1000));
END;
$fn$;
-- anon-exec: revoked in 20260922205752; CREATE OR REPLACE keeps the ACL. Re-stated here:
REVOKE EXECUTE ON FUNCTION public.refresh_allday_listings_sold_after_listing() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_allday_listings_sold_after_listing() TO service_role;

DO $assert$
BEGIN
  IF position('v_coll' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.refresh_allday_listings_sold_after_listing()'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'body still uses v_coll';
  END IF;
  IF has_function_privilege('anon', 'public.refresh_allday_listings_sold_after_listing()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute the refresher';
  END IF;
END
$assert$;
