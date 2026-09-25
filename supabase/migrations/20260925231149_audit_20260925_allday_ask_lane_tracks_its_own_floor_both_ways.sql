-- audit_20260925_allday_ask_lane_tracks_its_own_floor_both_ways
--
-- refresh_allday_ask_fmv_from_listings (pg_cron job 19) only ever re-capped an
-- ASK_ONLY price DOWNWARD (latest fmv > live ask). A price it wrote stayed put when
-- the floor ROSE — e.g. after the cheapest listing sold — so it drifted below
-- anything buyable. That became concrete on 2026-09-25: 27,406 unpurchasable
-- Flowty-fork All Day listings (20260925230134) had been setting floors, and ~15 of
-- this lane's rows were priced off them. Its own rows (algo_version
-- 'allday-listing-ask-v1') are now re-derived whenever 90% of the live floor moves
-- by a cent or more, in either direction — the same rule the Golazos lane has had
-- since 20260925224605. Other writers' ASK_ONLY rows keep the old rule (re-capped
-- only when above the ask). Everything else is unchanged from 20260923220355.
-- recapped_above_live_ask now counts only true re-caps; the new
-- tracked_floor_change counts this lane's own re-derivations.
--
-- anon-exec: unchanged — CREATE OR REPLACE of an existing SECURITY DEFINER function
-- keeps its ACL (read 2026-09-25: anon cannot execute it).
--
-- REVERT: re-apply the function body from
-- 20260923220355_audit_20260923_allday_ask_only_recaps_when_the_live_ask_drops.sql.

CREATE OR REPLACE FUNCTION public.refresh_allday_ask_fmv_from_listings()
RETURNS TABLE(rescued integer, considered integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_coll        uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid;
  v_ceiling     numeric := 10000;
  v_today_start timestamptz := date_trunc('day', now());
  v_today_end   timestamptz := date_trunc('day', now()) + interval '1 day';
  v_rescued     int := 0;
  v_considered  int := 0;
  v_recapped    int := 0;
  v_ghost_skip  int := 0;
  v_tracked     int := 0;
  v_started     timestamptz := clock_timestamp();
BEGIN
  DROP TABLE IF EXISTS _ad_ask;
  CREATE TEMP TABLE _ad_ask ON COMMIT DROP AS
  SELECT cl.edition_id, MIN(cl.price_usd) AS low_ask
  FROM cached_listings_v2 cl
  WHERE cl.collection_id = v_coll
    AND cl.price_usd IS NOT NULL AND cl.price_usd > 0 AND cl.price_usd <= v_ceiling
    AND cl.completed_at IS NULL
    AND (cl.expiry_at IS NULL OR cl.expiry_at > now())
    AND NOT EXISTS (
      SELECT 1 FROM allday_listings_sold_after_listing g
      WHERE g.listing_resource_id = cl.listing_resource_id
        AND g.source = cl.source
    )
  GROUP BY cl.edition_id;

  SELECT count(DISTINCT cl.edition_id) INTO v_ghost_skip
  FROM cached_listings_v2 cl
  JOIN allday_listings_sold_after_listing g
    ON g.listing_resource_id = cl.listing_resource_id AND g.source = cl.source
  WHERE cl.collection_id = v_coll
    AND cl.price_usd IS NOT NULL AND cl.price_usd > 0 AND cl.price_usd <= v_ceiling
    AND cl.completed_at IS NULL
    AND (cl.expiry_at IS NULL OR cl.expiry_at > now())
    AND NOT EXISTS (SELECT 1 FROM _ad_ask a WHERE a.edition_id = cl.edition_id);

  DROP TABLE IF EXISTS _ad_targets;
  CREATE TEMP TABLE _ad_targets ON COMMIT DROP AS
  SELECT a.edition_id, a.low_ask, latest.conf, latest.fmv, latest.algo
  FROM _ad_ask a
  JOIN LATERAL (
    SELECT fs.confidence::text AS conf, fs.fmv_usd AS fmv, fs.algo_version AS algo
    FROM fmv_snapshots fs
    WHERE fs.edition_id = a.edition_id
    ORDER BY fs.computed_at DESC
    LIMIT 1
  ) latest ON true
  WHERE latest.conf IN ('STALE','NO_DATA')
     OR (latest.conf = 'ASK_ONLY' AND latest.fmv > a.low_ask)
     -- 2026-09-25: this lane's OWN rows follow the live floor in BOTH directions.
     -- Re-capping only downward left a price stranded below the market once its
     -- cheapest listing sold — and 27,406 unpurchasable Flowty-fork listings closed
     -- the same day had set exactly such floors.
     OR (latest.conf = 'ASK_ONLY' AND latest.algo = 'allday-listing-ask-v1'
         AND abs(latest.fmv - round(a.low_ask * 0.90, 2)) >= 0.01);

  v_considered := (SELECT count(*) FROM _ad_targets);
  v_recapped   := (SELECT count(*) FROM _ad_targets WHERE conf = 'ASK_ONLY' AND fmv > low_ask);
  v_tracked    := (SELECT count(*) FROM _ad_targets WHERE algo = 'allday-listing-ask-v1');

  IF v_considered > 0 THEN
    DELETE FROM fmv_snapshots fs
    USING _ad_targets t
    WHERE fs.edition_id   = t.edition_id
      AND fs.collection_id = v_coll
      AND fs.computed_at  >= v_today_start
      AND fs.computed_at  <  v_today_end;

    INSERT INTO fmv_snapshots (
      edition_id, collection_id, fmv_usd, floor_price_usd,
      asp_usd, ask_proxy_fmv, cross_market_ask,
      confidence, listing_count, algo_version, computed_at, collection,
      sales_count_7d, sales_count_30d
    )
    SELECT
      t.edition_id, v_coll,
      round(t.low_ask * 0.90, 2), round(t.low_ask, 2),
      round(t.low_ask * 0.90, 2), round(t.low_ask * 0.90, 2), round(t.low_ask, 2),
      'ASK_ONLY'::fmv_confidence, NULL, 'allday-listing-ask-v1', now(), 'nfl_all_day',
      0, 0
    FROM _ad_targets t;
    GET DIAGNOSTICS v_rescued = ROW_COUNT;
  END IF;

  INSERT INTO pipeline_runs (pipeline, ok, started_at, finished_at, extra)
  VALUES ('allday-listing-ask-fmv', true, v_started, clock_timestamp(),
          jsonb_build_object('rescued', v_rescued, 'considered', v_considered,
                             'recapped_above_live_ask', v_recapped,
                             'ghost_only_editions_skipped', v_ghost_skip,
                             'tracked_floor_change', v_tracked));

  RETURN QUERY SELECT v_rescued, v_considered;
END;
$fn$;
