-- audit_20260922_allday_floor_ask_excludes_listings_whose_nft_sold_after_listing
--
-- Trevor-approved 2026-09-22 ~1:50 PM PT ("Ship the view fix now").
--
-- WHY: fmv-recalc caps All Day FMV at allday_edition_floor_ask.floor_ask (ask-ceiling,
-- no age gate). The view picks the cheapest OPEN row in cached_listings_v2, and 13,890 of
-- 38,673 open All Day listings are GHOSTS: the NFT has SOLD (via another listing) after the
-- listing was created, so the listing can no longer be filled but never got completed_at.
-- Measured 1:35-1:50 PM PT: 55 % of All Day HIGH / 44 % of MEDIUM editions had FMV below
-- every one of their last 7 sales (Top Shot control: symmetric, median ratio 1.000); 180/184
-- equalled the floor; 722/740 of those "contradicted" floors were NFTs sold after listing.
-- Inbox: docs/overnight/inbox/2026-09-22T2045Z-allday-fmv-is-capped-by-month-old-floor-listings-the-market-clears-above.md
--
-- SHAPE: an inline NOT EXISTS against `sales` in the view cost 5,127 -> 139,392 buffers
-- (74 ms -> 1.3 s) per full read, and get_collection_stats / refresh_allday_badge_low_ask /
-- mv_cross_collection_deals all read the whole view. So the expensive probe runs ONCE per
-- 15 min into a small set table, and the view anti-joins that set by primary key.
-- "Sold after listed" is PERMANENT for a listing, so the set is add-only by nature; rows
-- whose listing leaves the open set are pruned each run.
--
-- FAILS OPEN: if the refresher stops, new ghosts are simply not excluded (the pre-fix
-- behaviour); nothing is hidden that was not already proven dead.
--
-- REVERT (one statement block):
--   SELECT cron.unschedule('rpc-allday-ghost-listings-refresh');
--   CREATE OR REPLACE VIEW public.allday_edition_floor_ask AS
--    SELECT DISTINCT ON (edition_id) edition_id, price_usd AS floor_ask, listed_at AS floor_ask_listed_at,
--      listing_resource_id AS floor_listing_resource_id, flow_id AS floor_flow_id
--    FROM cached_listings_v2 cl
--    WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid AND completed_at IS NULL
--      AND price_usd > 0::numeric AND (expiry_at IS NULL OR expiry_at > now()) AND edition_id IS NOT NULL
--    ORDER BY edition_id, price_usd, listed_at DESC;
--   ALTER VIEW public.allday_edition_floor_ask SET (security_invoker = on);
--   DROP FUNCTION public.refresh_allday_listings_sold_after_listing();
--   DROP TABLE public.allday_listings_sold_after_listing;

CREATE TABLE IF NOT EXISTS public.allday_listings_sold_after_listing (
  listing_resource_id bigint      NOT NULL,
  source              text        NOT NULL,
  flow_id             bigint      NOT NULL,
  listed_at           timestamptz,
  detected_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_resource_id, source)
);
COMMENT ON TABLE public.allday_listings_sold_after_listing IS
  'All Day open listings in cached_listings_v2 whose NFT has a sales row with sold_at > listed_at (unfillable ghosts). Written only by refresh_allday_listings_sold_after_listing() (pg_cron rpc-allday-ghost-listings-refresh, every 15 min); read by allday_edition_floor_ask to exclude them. 2026-09-22.';

ALTER TABLE public.allday_listings_sold_after_listing ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_all ON public.allday_listings_sold_after_listing;
CREATE POLICY service_role_all ON public.allday_listings_sold_after_listing
  USING ((SELECT auth.role()) = 'service_role');
REVOKE ALL ON public.allday_listings_sold_after_listing FROM PUBLIC, anon, authenticated;
-- SELECT mirrors cached_listings_v2: a security_invoker view needs it on every base table,
-- and RLS above still returns no rows to anon/authenticated.
GRANT SELECT ON public.allday_listings_sold_after_listing TO anon, authenticated;
GRANT ALL ON public.allday_listings_sold_after_listing TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_allday_listings_sold_after_listing()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_coll     uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_start    timestamptz := clock_timestamp();
  v_inserted int := 0;
  v_pruned   int := 0;
  v_total    int := 0;
BEGIN
  INSERT INTO public.allday_listings_sold_after_listing (listing_resource_id, source, flow_id, listed_at)
  SELECT cl.listing_resource_id, cl.source, cl.flow_id, cl.listed_at
  FROM public.cached_listings_v2 cl
  WHERE cl.collection_id = v_coll
    AND cl.completed_at IS NULL
    AND cl.listed_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.allday_listings_sold_after_listing g
                    WHERE g.listing_resource_id = cl.listing_resource_id AND g.source = cl.source)
    AND EXISTS (SELECT 1 FROM public.sales s
                WHERE s.nft_id = cl.flow_id::text
                  AND s.collection_id = v_coll
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
REVOKE EXECUTE ON FUNCTION public.refresh_allday_listings_sold_after_listing() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_allday_listings_sold_after_listing() TO service_role;

-- Seed the set before the view starts reading it.
SELECT public.refresh_allday_listings_sold_after_listing();

CREATE OR REPLACE VIEW public.allday_edition_floor_ask AS
 SELECT DISTINCT ON (edition_id) edition_id,
    price_usd AS floor_ask,
    listed_at AS floor_ask_listed_at,
    listing_resource_id AS floor_listing_resource_id,
    flow_id AS floor_flow_id
   FROM cached_listings_v2 cl
  WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid AND completed_at IS NULL AND price_usd > 0::numeric AND (expiry_at IS NULL OR expiry_at > now()) AND edition_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.allday_listings_sold_after_listing g
                    WHERE g.listing_resource_id = cl.listing_resource_id AND g.source = cl.source)
  ORDER BY edition_id, price_usd, listed_at DESC;
ALTER VIEW public.allday_edition_floor_ask SET (security_invoker = on);

SELECT cron.schedule('rpc-allday-ghost-listings-refresh', '7,22,37,52 * * * *',
  'SELECT public.refresh_allday_listings_sold_after_listing()');

DO $assert$
DECLARE v_n int; v_ghost int; v_ro text[];
BEGIN
  SELECT reloptions INTO v_ro FROM pg_class WHERE oid = 'public.allday_edition_floor_ask'::regclass;
  IF v_ro IS NULL OR NOT ('security_invoker=on' = ANY (v_ro)) THEN
    RAISE EXCEPTION 'allday_edition_floor_ask lost security_invoker (%)', v_ro;
  END IF;
  IF position('allday_listings_sold_after_listing' IN pg_get_viewdef('public.allday_edition_floor_ask'::regclass)) = 0 THEN
    RAISE EXCEPTION 'view does not read the ghost set';
  END IF;
  SELECT count(*) INTO v_ghost FROM public.allday_listings_sold_after_listing;
  IF v_ghost < 1000 THEN RAISE EXCEPTION 'ghost set seeded only % rows (expected ~13,900)', v_ghost; END IF;
  SELECT count(*) INTO v_n FROM public.allday_edition_floor_ask;
  IF v_n < 3000 THEN RAISE EXCEPTION 'floor view shrank to % editions (expected ~4,381)', v_n; END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-allday-ghost-listings-refresh' AND active) THEN
    RAISE EXCEPTION 'refresh job not scheduled';
  END IF;
END
$assert$;
