-- audit_20260922_allday_ask_only_needs_a_live_non_ghost_ask
--
-- TWO THINGS, ONE CAUSE. Found while acting on watch item W6 from the 2026-09-22
-- daytime handoff ("57 ASK_ONLY editions have no live floor — worth one look").
-- It was worth more than one look: the read-layer ghost fix shipped that
-- afternoon (20260922205752) does NOT close the hole, because a SECOND writer
-- re-creates it.
--
-- 🚨 `refresh_allday_ask_fmv_from_listings` (pg_cron job 19, every 6 h) rescues
-- STALE/NO_DATA editions into ASK_ONLY at `low_ask * 0.90`, and it reads
-- `cached_listings_v2` DIRECTLY — not the ghost-filtered `allday_edition_floor_ask`
-- view. So every ghost listing the floor view now excludes was still, six hours
-- later, being turned into a published price. It ran at 17:40 PT on 2026-09-22,
-- AFTER the floor fix landed at ~13:57, and rescued 12 editions.
-- Measured at the time: 3,000 All Day editions carry at least one ghost listing
-- in the population this function reads, and 182 have ONLY ghosts.
-- CLAUDE.md names this exactly: a READ-LAYER FIX DOES NOT CLOSE A FABRICATION
-- THE WRITE LAYER CAN RE-CREATE — grep the column's WRITERS; where TWO write one
-- column, PIN BOTH.
--
-- PART A — the rescuer anti-joins `allday_listings_sold_after_listing`, the same
-- single source of ghost truth the floor view uses (the SET is shared; only the
-- anti-join is written twice). It also now reports
-- `ghost_only_editions_skipped` into `pipeline_runs.extra`, so the thing it
-- REFUSES to price is counted rather than silent. First run after the change:
-- rescued 10, considered 10, ghost_only_editions_skipped 182 — i.e. it still
-- rescues from genuine live asks (positive control) and now declines 182.
--
-- PART B — retires the already-published ones. Trevor's call, taken 2026-09-22:
-- an ASK_ONLY price whose only input no longer exists should publish NOTHING,
-- not a stale number. 55 editions, up to $292.50, $1,527.46 of FMV in total,
-- written as `NO_DATA` with `fmv_usd NULL` — the shape the other 812 All Day
-- NO_DATA rows already use.
-- ⭐ THIS IS NOT A NEW PRODUCT RULE, IT IS THE PUBLISHED ONE. `lib/analytics/
-- methodology.ts` already tells readers: "an ask we have not re-confirmed in
-- over a week no longer corroborates a price at all." The code simply did not
-- do it.
--
-- ⚠ THE SNAPSHOT FIX IS NOT THE SURFACE FIX. `edition_fmv_current` is a cache
-- and it is what the surfaces read; after this migration all 55 were still
-- priced there until `refresh_edition_fmv_current(false)` ran (117 ms, 7,622
-- upserted), after which the count is 0. A future change here must refresh it
-- too, or the fix is invisible to users.
--
-- REVERT: re-apply the previous body of `refresh_allday_ask_fmv_from_listings`
-- (identical minus the NOT EXISTS block and the v_ghost_skip counter), then
-- DELETE FROM fmv_snapshots WHERE algo_version = 'allday-ask-retired-v1', then
-- SELECT public.refresh_edition_fmv_current(false).
--
-- anon-exec: intentional — refresh_allday_ask_fmv_from_listings keeps the ACL it
-- already has. This is a CREATE OR REPLACE snapshot, and CREATE OR REPLACE does
-- NOT reset a function ACL, so adding a REVOKE here would be a production change
-- this migration does not intend to make. Verified live against the database
-- immediately before shipping: has_function_privilege reads anon=false,
-- authenticated=false, service_role=true, postgres=true. It is an internal
-- writer driven by pg_cron job 19; no client role should reach it.

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
  SELECT a.edition_id, a.low_ask
  FROM _ad_ask a
  JOIN LATERAL (
    SELECT fs.confidence::text AS conf
    FROM fmv_snapshots fs
    WHERE fs.edition_id = a.edition_id
    ORDER BY fs.computed_at DESC
    LIMIT 1
  ) latest ON true
  WHERE latest.conf IN ('STALE','NO_DATA');

  v_considered := (SELECT count(*) FROM _ad_targets);

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
                             'ghost_only_editions_skipped', v_ghost_skip));

  RETURN QUERY SELECT v_rescued, v_considered;
END;
$fn$;

-- Retire the already-published ASK_ONLY prices whose ask no longer exists.
WITH latest AS (
  SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.confidence::text AS conf
  FROM fmv_snapshots fs
  WHERE fs.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
  ORDER BY fs.edition_id, fs.computed_at DESC
),
targets AS (
  SELECT l.edition_id FROM latest l
  LEFT JOIN allday_edition_floor_ask f ON f.edition_id = l.edition_id AND f.floor_ask IS NOT NULL
  WHERE l.conf = 'ASK_ONLY' AND f.edition_id IS NULL
)
INSERT INTO fmv_snapshots (
  edition_id, collection_id, fmv_usd, floor_price_usd,
  asp_usd, ask_proxy_fmv, cross_market_ask,
  confidence, listing_count, algo_version, computed_at, collection,
  sales_count_7d, sales_count_30d
)
SELECT t.edition_id, 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid,
       NULL, NULL, NULL, NULL, NULL,
       'NO_DATA'::fmv_confidence, NULL, 'allday-ask-retired-v1', now(), 'nfl_all_day',
       0, 0
FROM targets t;

DO $assert$
DECLARE v_left int;
BEGIN
  WITH latest AS (
    SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.confidence::text AS conf, fs.fmv_usd
    FROM fmv_snapshots fs
    WHERE fs.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
    ORDER BY fs.edition_id, fs.computed_at DESC
  )
  SELECT count(*) INTO v_left
  FROM latest l
  LEFT JOIN allday_edition_floor_ask f ON f.edition_id = l.edition_id AND f.floor_ask IS NOT NULL
  WHERE l.conf = 'ASK_ONLY' AND f.edition_id IS NULL;

  IF v_left > 0 THEN
    RAISE EXCEPTION '% All Day editions still publish an ASK_ONLY price with no live ask', v_left;
  END IF;

  IF position('allday_listings_sold_after_listing' IN
      (SELECT prosrc FROM pg_proc WHERE oid = 'public.refresh_allday_ask_fmv_from_listings()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the ASK_ONLY rescuer does not exclude ghost listings';
  END IF;
END
$assert$;
