-- audit_20260925_golazos_ask_fmv_moves_off_flowty_onto_the_onchain_book
--
-- Trevor 2026-09-25: "Proceed" — price LaLiga Golazos from its own on-chain listing
-- book instead of Flowty's cache, which is expected to stop when Flowty switches its
-- API off.
--
-- THREE CHANGES.
--  1. cached_listings_v2.verified_at — when golazos-storefront-reconcile last saw the
--     listing live in its seller's storefront. NULL on rows it has not confirmed.
--  2. refresh_golazos_ask_fmv_from_listings() — the Golazos ASK_ONLY lane, shaped
--     like refresh_allday_ask_fmv_from_listings (FMV 90% of the cheapest live ask,
--     never touching a sales-backed row) with two differences: a freshness bound
--     (a listing counts only if confirmed or listed within 6 h, so a stalled
--     reconciler stops pricing instead of re-publishing old asks), and it tracks its
--     own rows when the floor moves in EITHER direction (All Day's lane only
--     re-caps downward). It also moves the Flowty-derived ASK_ONLY rows
--     (ask_only_v2*) onto the book. pg_cron every 2 h at :55, 12 min after the
--     reconciler (:43).
--  3. fmv_from_cached_listings returns 0 for Golazos, as it has for All Day since
--     20260923205831 — one writer per lane. Everything else in it is unchanged.
--
-- MEASURED BEFORE (2026-09-25 ~3:30 PM PT): Golazos has 490 editions with an open
-- on-chain listing; of those, latest FMV is STALE 290, NO_DATA 2, ASK_ONLY 160 (10
-- above the live ask), LOW 32, MEDIUM 4. The 66 Flowty-priced editions carry
-- ask_only_v2_haircut. Sales-backed rows are out of scope by construction.
--
-- anon-exec: fmv_from_cached_listings unchanged — CREATE OR REPLACE of an existing
-- function keeps its ACL. refresh_golazos_ask_fmv_from_listings is REVOKEd from
-- PUBLIC, anon, authenticated below: it writes prices and its only caller is
-- pg_cron running as postgres (the owner), which keeps EXECUTE.
--
-- REVERT: SELECT cron.unschedule('refresh-golazos-ask-fmv'); DROP FUNCTION
-- public.refresh_golazos_ask_fmv_from_listings(); re-apply fmv_from_cached_listings
-- from 20260925152928; ALTER TABLE cached_listings_v2 DROP COLUMN verified_at; the
-- golazos-listing-ask-v1 snapshots are replaced by the next writer of each edition.

ALTER TABLE public.cached_listings_v2 ADD COLUMN IF NOT EXISTS verified_at timestamptz;
COMMENT ON COLUMN public.cached_listings_v2.verified_at IS
  'When golazos-storefront-reconcile last confirmed this listing live in its seller''s NFTStorefrontV2. NULL = never confirmed by a storefront walk (event-only row). Golazos ask pricing requires COALESCE(verified_at, listed_at) within 6 h.';

CREATE OR REPLACE FUNCTION public.fmv_from_cached_listings(p_collection_id uuid, p_algo_version text DEFAULT 'ask_only_v2'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  rows_inserted integer := 0;
  ask_price_ceiling numeric := 5000;
  -- 2026-09-25: only listings the cache fetched within this window are priced. When
  -- Flowty's API stops answering, every listing-cache sweep fails and the route keeps
  -- its prior cache (right for a blip), so without this bound the lane re-stamped
  -- those frozen asks as fresh ASK_ONLY rows (computed_at = NOW()) every 20 minutes
  -- until the daily 48 h purge emptied the cache. A stale listing now neither deletes
  -- nor re-writes: the edition keeps its last row, whose computed_at ages honestly.
  -- 2 h = six missed 20-minute ticks, so a short upstream blip changes nothing.
  listing_max_age interval := interval '2 hours';
BEGIN
  -- 2026-09-23: NFL All Day is NOT priced here. Its ASK_ONLY lane is owned by
  -- fmv-recalc Step 5d and refresh_allday_ask_fmv_from_listings, both of which read
  -- the on-chain listings (cached_listings_v2) through the ghost filter
  -- (allday_listings_sold_after_listing). The Flowty cache this function reads held
  -- mostly $1,000,000 troll asks for All Day, and publishing Flowty's valuation over
  -- them put FMVs 20x above a live buy-it-now (Jer'Zhan Newton $60.39 vs a $3 ask) and
  -- re-created prices the ghost fix had just retired.
  IF p_collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid THEN
    RETURN 0;
  END IF;

  -- 2026-09-25: LaLiga Golazos is NOT priced here either. Its ASK_ONLY lane moved to
  -- refresh_golazos_ask_fmv_from_listings(), which reads the on-chain book in
  -- cached_listings_v2 (kept by golazos-storefront-reconcile: 3,338 live listings
  -- across 490 editions vs Flowty's ~67 moments) and survives Flowty switching its
  -- API off. Pricing Golazos here too would put two writers on one lane, each
  -- deleting the other's ASK_ONLY rows every 20 minutes.
  IF p_collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid THEN
    RETURN 0;
  END IF;

  -- Targeted DELETE: only this lane's own ASK_ONLY rows. It used to delete LOW rows
  -- too, which let a Flowty valuation replace a sales-derived LOW price.
  DELETE FROM fmv_snapshots fs
  WHERE fs.collection_id = p_collection_id
    AND fs.confidence = 'ASK_ONLY'::fmv_confidence
    AND fs.edition_id IN (
      SELECT DISTINCT e.id
      FROM cached_listings cl
      JOIN editions e ON e.collection_id = p_collection_id
        AND (
          (cl.moment_id IS NOT NULL AND e.external_id = cl.moment_id)
          OR
          (e.player_name IS NOT NULL AND cl.player_name IS NOT NULL
           AND normalize_name(e.player_name) = normalize_name(cl.player_name)
           AND normalize_name(e.set_name) = normalize_name(cl.set_name))
        )
      WHERE cl.collection_id = p_collection_id
        AND cl.ask_price > 0
        AND cl.cached_at > NOW() - listing_max_age
        AND NOT EXISTS (
          SELECT 1 FROM fmv_snapshots f2
          WHERE f2.edition_id = e.id
            AND f2.confidence IN ('HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence, 'LOW'::fmv_confidence)
        )
    );

  -- INSERT new ASK_ONLY rows. The valuation is capped at the cheapest ask under the
  -- sanity ceiling (the ask-ceiling rule: a base FMV above buy-it-now is a confident
  -- wrong number), and an ask above the ceiling is never recorded as a floor.
  INSERT INTO fmv_snapshots (
    edition_id, collection_id, fmv_usd, floor_price_usd, asp_usd,
    confidence, listing_count, algo_version, computed_at,
    liquidity_rating, top_shot_ask, flowty_ask, cross_market_ask
  )
  SELECT
    e.id AS edition_id,
    p_collection_id,
    -- Primary: avg of cl.fmv when present; fallback: MIN(ask_price) under the ceiling.
    -- LEAST ignores NULLs, so an ask above the ceiling simply does not cap.
    LEAST(
      COALESCE(
        NULLIF(ROUND(AVG(cl.fmv) FILTER (WHERE cl.fmv > 0), 2), 0),
        CASE
          WHEN MIN(cl.ask_price) <= ask_price_ceiling
          THEN ROUND(MIN(cl.ask_price), 2)
          ELSE NULL  -- no FMV row produced — better silence than $1M garbage
        END
      ),
      CASE
        WHEN MIN(cl.ask_price) <= ask_price_ceiling
        THEN ROUND(MIN(cl.ask_price), 2)
        ELSE NULL
      END
    ) AS fmv_usd,
    CASE WHEN MIN(cl.ask_price) <= ask_price_ceiling THEN ROUND(MIN(cl.ask_price), 2) ELSE NULL END AS floor_price_usd,
    NULL AS wap_usd,
    'ASK_ONLY'::fmv_confidence AS confidence,
    COUNT(cl.id)::int AS listing_count,
    p_algo_version,
    NOW(),
    1 AS liquidity_rating,
    NULL AS top_shot_ask,
    CASE WHEN MIN(cl.ask_price) <= ask_price_ceiling THEN ROUND(MIN(cl.ask_price), 2) ELSE NULL END AS flowty_ask,
    CASE WHEN MIN(cl.ask_price) <= ask_price_ceiling THEN ROUND(MIN(cl.ask_price), 2) ELSE NULL END AS cross_market_ask
  FROM cached_listings cl
  JOIN editions e ON e.collection_id = p_collection_id
    AND (
      (cl.moment_id IS NOT NULL AND e.external_id = cl.moment_id)
      OR
      (e.player_name IS NOT NULL AND cl.player_name IS NOT NULL
       AND normalize_name(e.player_name) = normalize_name(cl.player_name)
       AND normalize_name(e.set_name) = normalize_name(cl.set_name))
    )
  WHERE cl.collection_id = p_collection_id
    AND cl.ask_price > 0
    AND cl.cached_at > NOW() - listing_max_age
    AND NOT EXISTS (
      SELECT 1 FROM fmv_snapshots fs2
      WHERE fs2.edition_id = e.id
        AND fs2.confidence IN ('HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence, 'LOW'::fmv_confidence)
    )
  GROUP BY e.id
  -- HAVING clause excludes editions where the resulting fmv_usd would be NULL
  HAVING COALESCE(
    NULLIF(ROUND(AVG(cl.fmv) FILTER (WHERE cl.fmv > 0), 2), 0),
    CASE
      WHEN MIN(cl.ask_price) <= ask_price_ceiling
      THEN ROUND(MIN(cl.ask_price), 2)
      ELSE NULL
    END
  ) IS NOT NULL;

  GET DIAGNOSTICS rows_inserted = ROW_COUNT;
  RETURN rows_inserted;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_golazos_ask_fmv_from_listings()
 RETURNS TABLE(rescued integer, considered integer)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_coll        uuid := '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid;
  v_ceiling     numeric := 10000;
  -- A listing counts only if golazos-storefront-reconcile (every 2 h) confirmed it
  -- within this window, or the event indexer saw it listed within it. Three missed
  -- reconcile runs and the book stops pricing instead of re-publishing itself.
  v_max_age     interval := interval '6 hours';
  v_today_start timestamptz := date_trunc('day', now());
  v_today_end   timestamptz := date_trunc('day', now()) + interval '1 day';
  v_rescued     int := 0;
  v_considered  int := 0;
  v_recapped    int := 0;
  v_off_flowty  int := 0;
  v_tracked     int := 0;
  v_unverified  int := 0;
  v_started     timestamptz := clock_timestamp();
BEGIN
  DROP TABLE IF EXISTS _gz_ask;
  CREATE TEMP TABLE _gz_ask ON COMMIT DROP AS
  SELECT cl.edition_id, MIN(cl.price_usd) AS low_ask, COUNT(*)::int AS n
  FROM cached_listings_v2 cl
  WHERE cl.collection_id = v_coll
    AND cl.edition_id IS NOT NULL
    AND cl.source IN ('direct_v2', 'storefront_v2')
    AND cl.price_usd IS NOT NULL AND cl.price_usd > 0 AND cl.price_usd <= v_ceiling
    AND cl.completed_at IS NULL
    AND (cl.expiry_at IS NULL OR cl.expiry_at > now())
    AND COALESCE(cl.verified_at, cl.listed_at) > now() - v_max_age
  GROUP BY cl.edition_id;

  -- Open listings excluded ONLY for being unconfirmed — reported so a stalled
  -- reconciler reads as a stalled reconciler, not as a quiet market.
  SELECT count(*) INTO v_unverified
  FROM cached_listings_v2 cl
  WHERE cl.collection_id = v_coll
    AND cl.edition_id IS NOT NULL
    AND cl.source IN ('direct_v2', 'storefront_v2')
    AND cl.price_usd IS NOT NULL AND cl.price_usd > 0 AND cl.price_usd <= v_ceiling
    AND cl.completed_at IS NULL
    AND (cl.expiry_at IS NULL OR cl.expiry_at > now())
    AND COALESCE(cl.verified_at, cl.listed_at, '-infinity'::timestamptz) <= now() - v_max_age;

  -- Which editions to (re)price. Never a sales-backed HIGH/MEDIUM/LOW row.
  --   STALE / NO_DATA                  → rescue from the live ask
  --   ASK_ONLY above the live ask      → re-cap (the ask-ceiling rule)
  --   ASK_ONLY from Flowty (ask_only_v2*) → move onto the on-chain book
  --   this lane's own row, floor moved → track the floor both ways
  DROP TABLE IF EXISTS _gz_targets;
  CREATE TEMP TABLE _gz_targets ON COMMIT DROP AS
  SELECT a.edition_id, a.low_ask, a.n, latest.conf, latest.algo, latest.fmv
  FROM _gz_ask a
  JOIN LATERAL (
    SELECT fs.confidence::text AS conf, fs.fmv_usd AS fmv, fs.algo_version AS algo
    FROM fmv_snapshots fs
    WHERE fs.edition_id = a.edition_id
    ORDER BY fs.computed_at DESC
    LIMIT 1
  ) latest ON true
  WHERE latest.conf IN ('STALE', 'NO_DATA')
     OR (latest.conf = 'ASK_ONLY' AND latest.fmv > a.low_ask)
     OR (latest.conf = 'ASK_ONLY' AND latest.algo LIKE 'ask_only_v2%')
     OR (latest.conf = 'ASK_ONLY' AND latest.algo = 'golazos-listing-ask-v1'
         AND abs(latest.fmv - round(a.low_ask * 0.90, 2)) >= 0.01);

  v_considered := (SELECT count(*) FROM _gz_targets);
  v_recapped   := (SELECT count(*) FROM _gz_targets WHERE conf = 'ASK_ONLY' AND fmv > low_ask);
  v_off_flowty := (SELECT count(*) FROM _gz_targets WHERE algo LIKE 'ask_only_v2%');
  v_tracked    := (SELECT count(*) FROM _gz_targets WHERE algo = 'golazos-listing-ask-v1');

  IF v_considered > 0 THEN
    -- Today's non-sales rows only: a sales-backed row is never deleted here.
    DELETE FROM fmv_snapshots fs
    USING _gz_targets t
    WHERE fs.edition_id    = t.edition_id
      AND fs.collection_id = v_coll
      AND fs.computed_at  >= v_today_start
      AND fs.computed_at  <  v_today_end
      AND fs.confidence IN ('STALE'::fmv_confidence, 'NO_DATA'::fmv_confidence, 'ASK_ONLY'::fmv_confidence);

    -- Same shape as the All Day lane (allday-listing-ask-v1): FMV 90% of the
    -- cheapest live ask, the ask itself recorded as the floor. FMV != floor, so the
    -- thin-sale haircut (which only touches fmv ≈ floor) does not cut it again.
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
      'ASK_ONLY'::fmv_confidence, t.n, 'golazos-listing-ask-v1', now(), 'laliga_golazos',
      0, 0
    FROM _gz_targets t;
    GET DIAGNOSTICS v_rescued = ROW_COUNT;
  END IF;

  INSERT INTO pipeline_runs (pipeline, collection_slug, ok, started_at, finished_at, rows_found, rows_written, extra)
  VALUES ('golazos-listing-ask-fmv', 'laliga_golazos', true, v_started, clock_timestamp(), v_considered, v_rescued,
          jsonb_build_object('priced', v_rescued, 'considered', v_considered,
                             'editions_with_fresh_ask', (SELECT count(*) FROM _gz_ask),
                             'recapped_above_live_ask', v_recapped,
                             'moved_off_flowty', v_off_flowty,
                             'tracked_floor_change', v_tracked,
                             'open_listings_unverified', v_unverified));

  RETURN QUERY SELECT v_rescued, v_considered;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_golazos_ask_fmv_from_listings() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule(
  'refresh-golazos-ask-fmv',
  '55 */2 * * *',
  'SELECT public.refresh_golazos_ask_fmv_from_listings();'
);
