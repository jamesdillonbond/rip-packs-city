-- audit_20260922_ghost_listings_refresh_probes_per_listing_via_lateral_limit
--
-- Second follow-up to 20260922205752 (same session, ~2:55 PM PT). 20260922210944 inlined
-- the collection literal, but job 596 still ran 20 s (2:22 PM PT) and 25 s (2:37 PM PT).
-- pg_stat_statements: 757,388 buffers per call. Cause, from EXPLAIN of the INSERT itself:
-- an INSERT cannot use a parallel plan, and the SERIAL plan for `EXISTS (… sales …)` is a
-- Hash Semi Join that hashes ALL ~804k All Day sales across every partition. The earlier
-- 1.75 s measurement was a parallel SELECT, i.e. not the production shape (a probe whose
-- harness differs from production in the one dimension that matters).
--
-- Fix: the sales probe becomes CROSS JOIN LATERAL (… LIMIT 1), which forces a
-- per-listing, run-time-partition-pruned nft_id index probe; and the already-flagged
-- listings are removed BEFORE the probe (OFFSET 0 fence). Measured serial
-- (max_parallel_workers_per_gather=0) on the probe-everything variant: 161k buffers,
-- 2.8 s; the fence drops ~17.6k of ~44k probes.
--
-- REVERT: re-apply the body from 20260922210944 (correct, slower).

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
  SELECT c.listing_resource_id, c.source, c.flow_id, c.listed_at
  FROM (
    SELECT cl.listing_resource_id, cl.source, cl.flow_id, cl.listed_at
    FROM public.cached_listings_v2 cl
    WHERE cl.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
      AND cl.completed_at IS NULL
      AND cl.listed_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.allday_listings_sold_after_listing g
                      WHERE g.listing_resource_id = cl.listing_resource_id AND g.source = cl.source)
    OFFSET 0
  ) c
  CROSS JOIN LATERAL (
    SELECT 1 FROM public.sales s
    WHERE s.nft_id = c.flow_id::text
      AND s.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
      AND s.sold_at > c.listed_at
    LIMIT 1
  ) sold
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
  IF position('CROSS JOIN LATERAL' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.refresh_allday_listings_sold_after_listing()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'body lacks the lateral probe';
  END IF;
  IF position('v_coll' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.refresh_allday_listings_sold_after_listing()'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'body still uses v_coll';
  END IF;
  IF has_function_privilege('anon', 'public.refresh_allday_listings_sold_after_listing()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute the refresher';
  END IF;
END
$assert$;
