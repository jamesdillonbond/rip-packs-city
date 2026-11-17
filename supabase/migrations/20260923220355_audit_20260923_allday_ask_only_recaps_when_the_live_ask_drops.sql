-- audit_20260923_allday_ask_only_recaps_when_the_live_ask_drops
--
-- An All Day ASK_ONLY price is `ask * 0.90` at the moment it is written, and then
-- nothing ever revisits it. When a cheaper listing arrives the published FMV sits
-- ABOVE a live buy-it-now, which is the confident-wrong shape the ask-ceiling
-- exists to stop.
-- Measured 2026-09-23 ~2:55 PM PT: 26 All Day editions whose latest snapshot is
-- ASK_ONLY sat above the live ghost-filtered floor. They were 8 h to 7 days old,
-- from four writers: cold-tail-1.0 14 (avg 1.27x), fmv-recalc 1.7.0 7 (2.05x),
-- this function's own allday-listing-ask-v1 4 (1.84x), ask_only_v2_p90clamp 1.
-- None of them is re-examined: this rescuer took only STALE/NO_DATA, and
-- drain_fmv_cold_tail only re-reads an edition after 7 days of no snapshot.
--
-- THE CHANGE: an edition whose latest snapshot is ASK_ONLY and whose fmv_usd is
-- above today's live, non-ghost MIN ask is now a target too, and is re-priced at
-- that ask * 0.90 exactly as a rescue is. Only ASK_ONLY is widened. A sales-derived
-- HIGH/MEDIUM/LOW is never touched here; fmv-recalc caps those at the ask itself.
-- The trigger is `fmv > low_ask`, not `fmv > low_ask * 0.90`, so a price already
-- at or under buy-it-now does not churn every 6 h over a few cents.
-- The re-capped count is reported as `recapped_above_live_ask` in
-- pipeline_runs.extra, so it is visible separately from `rescued`.
--
-- ⚠ drain_fmv_cold_tail reads badge_editions.low_ask for All Day, not the live
-- floor. It can re-write a higher ask after 7 quiet days; this job then re-caps it
-- within 6 h. Bounded, not a fight — but that writer is the next one to point at
-- the live floor.
--
-- ⚠ THE SNAPSHOT IS NOT THE SURFACE: run
-- `SELECT public.refresh_edition_fmv_current(false);` after the first run.
--
-- REVERT: re-apply the body from 20260923011039 (identical minus the fmv column in
-- the LATERAL, the ASK_ONLY arm of the target predicate, and v_recapped), then
-- SELECT public.refresh_edition_fmv_current(false). The re-capped rows are
-- ordinary ASK_ONLY snapshots at ask * 0.90 and need no cleanup.
--
-- anon-exec: intentional — refresh_allday_ask_fmv_from_listings keeps the ACL it
-- already has. CREATE OR REPLACE does not reset a function ACL, so adding a REVOKE
-- here would be a production change this migration does not intend to make.
-- Unchanged since 20260923011039: anon=false, authenticated=false,
-- service_role=true. It is an internal writer driven by pg_cron job 19.

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
  SELECT a.edition_id, a.low_ask, latest.conf
  FROM _ad_ask a
  JOIN LATERAL (
    SELECT fs.confidence::text AS conf, fs.fmv_usd AS fmv
    FROM fmv_snapshots fs
    WHERE fs.edition_id = a.edition_id
    ORDER BY fs.computed_at DESC
    LIMIT 1
  ) latest ON true
  WHERE latest.conf IN ('STALE','NO_DATA')
     OR (latest.conf = 'ASK_ONLY' AND latest.fmv > a.low_ask);

  v_considered := (SELECT count(*) FROM _ad_targets);
  v_recapped   := (SELECT count(*) FROM _ad_targets WHERE conf = 'ASK_ONLY');

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
                             'ghost_only_editions_skipped', v_ghost_skip));

  RETURN QUERY SELECT v_rescued, v_considered;
END;
$fn$;

DO $assert$
BEGIN
  IF position('latest.fmv > a.low_ask' IN
      (SELECT prosrc FROM pg_proc WHERE oid = 'public.refresh_allday_ask_fmv_from_listings()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the ASK_ONLY rescuer does not re-cap an ASK_ONLY price above the live ask';
  END IF;
  IF position('allday_listings_sold_after_listing' IN
      (SELECT prosrc FROM pg_proc WHERE oid = 'public.refresh_allday_ask_fmv_from_listings()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the ASK_ONLY rescuer does not exclude ghost listings';
  END IF;
END
$assert$;
