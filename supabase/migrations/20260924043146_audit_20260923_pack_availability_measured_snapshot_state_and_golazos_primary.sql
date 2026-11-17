-- 2026-09-23 · Pack availability becomes MEASURED for All Day and LaLiga Golazos,
-- instead of NULL ("unknown") by default.
--
-- BEFORE (pack_table_rows, measured 2026-09-23 ~9:30 PM PT):
--   nfl-all-day     3,077 dists: secondary true 862, false 0, primary never set, unknown 2,215
--   laliga-golazos    224 dists: all 224 unknown
--   nba-top-shot    2,543 dists: 525 unknown
-- lib/pack-availability.ts renders NULL/NULL as "unknown" on purpose (a
-- "Retired" badge on an unmeasured row was a fabricated claim, 2026-08-04). The
-- fix is to MEASURE, not to relabel:
--
-- 1. SECONDARY — "not listed" is a measurement when the listing snapshot for
--    that collection is fresh and complete. snapshot-pack-asks already walks
--    Dapper's sealed-pack listing index (searchPackNftAggregation, collector
--    listings only) every few minutes into pack_ask_state, and a dist absent
--    from a complete walk HAS no collector listing. What was missing is a record
--    of WHEN the last complete walk landed per collection, because
--    pack_ask_state.last_checked_at only moves on change (the 386 MB/day WAL
--    fix). upsert_pack_ask_state now stamps pack_ask_snapshot_state at the end
--    of every call (it is only called after a fully-paged, error-free fetch —
--    fetchLivePackListings throws on any GraphQL error). pack_table_rows reads
--    secondary_available = true when listed, false when not listed AND that
--    collection's walk is < 60 min old, else the EV writer's value (NULL when
--    it has none). A stale walk therefore falls back to "unknown", never to a
--    confident "not listed".
--    Golazos joins SUPPORTED_PACK_COLLECTIONS in lib/packs/live-pack-listings.ts
--    in the same change (1 Golazos dist is collector-listed today).
-- 2. PRIMARY — All Day: pack_distributions.metadata.endTime in the past is a
--    closed primary window (1,444 of 3,077 dists), so primary_available=false.
--    Golazos: Dapper searchDistributions (224 of 224 dists, fetched 2026-09-23)
--    is stored under primary_* metadata keys (never touching the seeder's keys);
--    primary_available = state <> 'Complete' AND availableSupply > 0 AND the
--    start/end window contains now(). Measured: 0 of 224 are on sale (205 carry
--    the 2122 placeholder window Dapper uses for unscheduled reward/claim dists).
--    Anything else stays NULL.
--
-- REVERT: part 2 carries the pack_table_rows revert (its prior body is saved in
-- public.audit_20260923_pack_table_rows_prev). For this part: re-create
-- upsert_pack_ask_state WITHOUT the final "INSERT INTO public.pack_ask_snapshot_state"
-- statement (the rest of the body is byte-identical to the prior version), DROP TABLE
-- public.pack_ask_snapshot_state, and
--   UPDATE pack_distributions SET metadata = metadata - 'primary_state' - 'primary_available_supply'
--     - 'primary_total_supply' - 'primary_start_time' - 'primary_end_time' - 'primary_checked_at'
--   WHERE collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75';
--
-- anon-exec: NOT intentional for upsert_pack_ask_state — ops writer; CREATE OR REPLACE keeps its ACL (postgres, service_role), re-asserted below.

CREATE TABLE IF NOT EXISTS public.pack_ask_snapshot_state (
  collection_slug text PRIMARY KEY,
  last_ok_at      timestamptz NOT NULL,
  total_listed    integer NOT NULL
);
ALTER TABLE public.pack_ask_snapshot_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pack_ask_snapshot_state FROM anon, authenticated;
GRANT SELECT ON public.pack_ask_snapshot_state TO anon, authenticated;
COMMENT ON TABLE public.pack_ask_snapshot_state IS
  'When the last COMPLETE listing walk landed per collection (written by upsert_pack_ask_state). pack_table_rows only reads "not listed" as a fact while this is < 60 min old. 2026-09-23.';

CREATE OR REPLACE FUNCTION public.upsert_pack_ask_state(p_collection_slug text, p_listings jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_now          timestamptz := now();
  v_total_listed int := 0;
  v_new          int := 0;
  v_changed      int := 0;
  v_dropped      int := 0;
BEGIN
  -- Smoke-test guard: rpc() autocommits per call (ON COMMIT DROP is enough in
  -- prod) but a manual execute_sql in one txn can hit "relation already exists".
  DROP TABLE IF EXISTS _fresh;
  CREATE TEMP TABLE _fresh ON COMMIT DROP AS
  SELECT (e->>'dist_id')                     AS dist_id,
         NULLIF(e->>'pack_listing_id','')    AS pack_listing_id,
         (e->>'lowest_ask')::numeric         AS lowest_ask
  FROM jsonb_array_elements(COALESCE(p_listings, '[]'::jsonb)) AS e
  WHERE (e->>'dist_id') IS NOT NULL
    AND (e->>'lowest_ask') IS NOT NULL
    AND (e->>'lowest_ask')::numeric > 0;

  SELECT count(*) INTO v_total_listed FROM _fresh;

  -- Classify against current state BEFORE the upsert (honest telemetry).
  SELECT
    count(*) FILTER (WHERE s.dist_id IS NULL OR s.is_listed = false),
    count(*) FILTER (WHERE s.dist_id IS NOT NULL AND s.is_listed = true AND f.lowest_ask <> s.lowest_ask)
  INTO v_new, v_changed
  FROM _fresh f
  LEFT JOIN public.pack_ask_state s
    ON s.collection_slug = p_collection_slug AND s.dist_id = f.dist_id;

  INSERT INTO public.pack_ask_state AS s
    (collection_slug, dist_id, pack_listing_id, lowest_ask, prev_ask,
     ask_first_seen_at, ask_changed_at, last_checked_at, is_listed)
  SELECT p_collection_slug, f.dist_id, f.pack_listing_id, f.lowest_ask, NULL,
         v_now, v_now, v_now, true
  FROM _fresh f
  ON CONFLICT (collection_slug, dist_id) DO UPDATE SET
    pack_listing_id = EXCLUDED.pack_listing_id,
    prev_ask = CASE
                 WHEN s.is_listed = false              THEN s.lowest_ask
                 WHEN EXCLUDED.lowest_ask <> s.lowest_ask THEN s.lowest_ask
                 ELSE s.prev_ask
               END,
    ask_first_seen_at = CASE WHEN s.is_listed = false THEN v_now ELSE s.ask_first_seen_at END,
    ask_changed_at = CASE
                       WHEN s.is_listed = false              THEN v_now
                       WHEN EXCLUDED.lowest_ask <> s.lowest_ask THEN v_now
                       ELSE s.ask_changed_at
                     END,
    lowest_ask = EXCLUDED.lowest_ask,
    last_checked_at = v_now,
    is_listed = true
  -- ⬇ THE ONLY CHANGE. Without it this DO UPDATE fired on every listed row every
  -- tick to move `last_checked_at` and nothing else: 386 MB of WAL a day.
  WHERE s.is_listed = false
     OR s.lowest_ask      IS DISTINCT FROM EXCLUDED.lowest_ask
     OR s.pack_listing_id IS DISTINCT FROM EXCLUDED.pack_listing_id;

  UPDATE public.pack_ask_state s
  SET is_listed = false, last_checked_at = v_now
  WHERE s.collection_slug = p_collection_slug
    AND s.is_listed = true
    AND NOT EXISTS (SELECT 1 FROM _fresh f WHERE f.dist_id = s.dist_id);
  GET DIAGNOSTICS v_dropped = ROW_COUNT;

  -- 2026-09-23: the walk that produced p_listings was COMPLETE (the caller only
  -- reaches here after a fully-paged, error-free fetch), so stamp it. This is
  -- what lets pack_table_rows read "absent" as "not listed" — and only while fresh.
  INSERT INTO public.pack_ask_snapshot_state AS ss (collection_slug, last_ok_at, total_listed)
  VALUES (p_collection_slug, v_now, v_total_listed)
  ON CONFLICT (collection_slug) DO UPDATE
    SET last_ok_at = EXCLUDED.last_ok_at, total_listed = EXCLUDED.total_listed;

  RETURN jsonb_build_object(
    'collection',   p_collection_slug,
    'total_listed', v_total_listed,
    'new',          v_new,
    'changed',      v_changed,
    'dropped',      v_dropped,
    'at',           v_now
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.upsert_pack_ask_state(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_pack_ask_state(text, jsonb) TO service_role, postgres;

-- Golazos primary facts from Dapper searchDistributions (fetched 2026-09-23 ~9:40 PM PT).
-- Row = [dist_id, state (C=Complete, I=Initialized), availableSupply, totalSupply, startTime UTC, endTime UTC].
DO $g$
DECLARE n int;
BEGIN
  UPDATE public.pack_distributions pd
     SET metadata = COALESCE(pd.metadata, '{}'::jsonb) || jsonb_build_object(
           'primary_state', CASE WHEN r->>1 = 'C' THEN 'Complete' ELSE 'Initialized' END,
           'primary_available_supply', (r->>2)::int,
           'primary_total_supply', (r->>3)::int,
           'primary_start_time', (r->>4) || ':00Z',
           'primary_end_time', (r->>5) || ':00Z',
           'primary_checked_at', '2026-09-24T04:40:00Z')
    FROM jsonb_array_elements('[[1,"C",-486,500,"2022-10-24T04:00","2122-12-15T20:30"],[2,"C",0,3000,"2022-10-27T09:00","2022-10-29T03:59"],[3,"C",0,1100,"2022-11-17T17:00","2022-11-19T04:00"],[4,"C",0,4500,"2022-11-17T18:00","2022-11-18T19:00"],[5,"C",0,98,"2122-10-24T04:00","2122-10-29T03:59"],[6,"C",0,135,"2122-10-24T04:00","2122-10-29T03:59"],[7,"C",0,355,"2122-10-24T04:00","2122-10-29T03:59"],[8,"C",0,2000,"2022-12-15T17:00","2022-12-15T20:30"],[9,"C",0,3000,"2022-12-15T18:30","2023-01-04T19:00"],[10,"C",0,89,"2122-10-24T04:00","2122-10-29T03:59"],[11,"C",0,78,"2122-10-24T04:00","2122-10-29T03:59"],[12,"C",0,141,"2122-10-24T04:00","2122-10-29T03:59"],[13,"C",0,140,"2122-10-24T04:00","2122-10-29T03:59"],[14,"C",0,69,"2122-10-24T04:00","2122-10-29T03:59"],[15,"C",0,500,"2122-10-24T04:00","2122-10-29T03:59"],[16,"C",0,331,"2122-10-24T15:20","2122-10-31T16:20"],[17,"C",0,81,"2122-10-24T15:20","2122-10-31T16:20"],[18,"C",0,1000,"2122-10-24T04:00","2122-10-29T03:59"],[19,"C",0,532,"2122-10-24T15:20","2122-10-31T16:20"],[20,"C",0,532,"2122-10-24T15:20","2122-10-31T16:20"],[21,"C",0,1461,"2122-10-24T15:20","2122-10-31T16:20"],[22,"C",0,739,"2122-10-24T15:20","2122-10-31T16:20"],[23,"C",0,301,"2122-10-24T15:20","2122-10-31T16:20"],[24,"C",0,39,"2122-10-24T15:20","2122-10-31T16:20"],[25,"C",0,386,"2122-10-24T15:20","2122-10-31T16:20"],[26,"C",0,17,"2122-10-24T15:20","2122-10-31T16:20"],[27,"C",0,111,"2122-10-24T15:20","2122-10-31T16:20"],[28,"C",0,120,"2122-10-24T15:20","2122-10-31T16:20"],[29,"I",0,0,"2122-10-24T15:20","2122-10-31T16:20"],[30,"C",0,250,"2122-10-24T15:20","2122-10-31T16:20"],[31,"C",0,15,"2122-10-24T15:20","2122-10-31T16:20"],[32,"C",0,234,"2122-10-24T15:20","2122-10-31T16:20"],[33,"C",0,22,"2122-10-24T15:20","2122-10-31T16:20"],[34,"C",0,3000,"2023-01-19T17:00","2023-01-20T20:30"],[35,"C",0,5000,"2023-01-19T18:30","2023-01-24T21:30"],[36,"C",0,42,"2122-10-24T15:20","2122-10-31T16:20"],[37,"C",0,75,"2122-10-24T15:20","2122-10-31T16:20"],[38,"C",0,160,"2122-10-24T15:20","2122-10-31T16:20"],[39,"C",0,58,"2122-10-24T15:20","2122-10-31T16:20"],[40,"C",0,17,"2122-10-24T15:20","2122-10-31T16:20"],[41,"C",0,89,"2122-10-24T15:20","2122-10-31T16:20"],[42,"C",0,162,"2122-10-24T15:20","2122-10-31T16:20"],[43,"C",0,54,"2122-10-24T15:20","2122-10-31T16:20"],[44,"C",0,103,"2122-10-24T15:20","2122-10-31T16:20"],[45,"C",0,57,"2122-10-24T15:20","2122-10-31T16:20"],[46,"C",0,19,"2122-10-24T15:20","2122-10-31T16:20"],[47,"C",0,204,"2122-10-24T15:20","2122-10-31T16:20"],[48,"I",0,172,"2122-10-24T15:20","2122-10-31T16:20"],[49,"I",0,2500,"2122-01-19T18:30","2122-02-01T19:00"],[50,"I",0,0,"2122-10-24T15:20","2122-10-31T16:20"],[51,"I",0,1,"2122-10-24T15:20","2122-10-31T16:20"],[52,"I",0,63,"2122-10-24T15:20","2122-10-31T16:20"],[53,"I",0,211,"2122-10-24T15:20","2122-10-31T16:20"],[54,"I",0,10000,"2122-10-24T15:20","2122-10-31T16:20"],[55,"I",0,2000,"2122-10-24T15:20","2122-10-31T16:20"],[56,"I",0,90,"2122-10-24T15:20","2122-10-31T16:20"],[183,"I",0,77,"2122-10-24T15:20","2122-10-31T16:20"],[184,"I",0,94,"2122-10-24T15:20","2122-10-31T16:20"],[185,"I",0,0,"2123-02-16T17:00","2123-03-02T17:30"],[186,"I",0,20000,"2023-02-16T18:30","2023-03-02T19:00"],[187,"I",0,2000,"2023-02-16T17:00","2023-02-17T17:30"],[188,"I",0,143,"2122-10-24T15:20","2122-10-31T16:20"],[194,"I",0,38,"2122-10-24T15:20","2122-10-31T16:20"],[195,"I",0,126,"2122-10-24T15:20","2122-10-31T16:20"],[196,"I",0,95,"2122-10-24T15:20","2122-10-31T16:20"],[197,"I",0,53,"2122-10-24T15:20","2122-10-31T16:20"],[198,"I",0,49,"2122-10-24T15:20","2122-10-31T16:20"],[199,"I",0,21,"2122-10-24T15:20","2122-10-31T16:20"],[200,"I",0,37,"2122-10-24T15:20","2122-10-31T16:20"],[201,"I",0,87,"2122-10-24T15:20","2122-10-31T16:20"],[205,"I",0,69,"2122-10-24T15:20","2122-10-31T16:20"],[206,"I",0,137,"2122-10-24T15:20","2122-10-31T16:20"],[212,"I",0,83,"2122-10-24T15:20","2122-10-31T16:20"],[213,"I",0,41,"2122-10-24T15:20","2122-10-31T16:20"],[214,"I",0,90000,"2122-10-24T15:20","2122-10-31T16:20"],[215,"I",0,0,"2122-10-24T15:20","2122-10-31T16:20"],[216,"I",0,2000,"2023-03-06T16:55","2023-03-10T19:30"],[217,"I",0,15000,"2023-03-06T16:55","2023-03-10T17:30"],[218,"I",0,10000,"2023-03-06T16:55","2023-03-22T19:00"],[219,"I",20566,24000,"2023-03-06T17:00","2023-09-30T19:00"],[220,"I",0,28,"2122-10-24T15:20","2122-10-31T16:20"],[221,"I",0,156,"2122-10-24T15:20","2122-10-31T16:20"],[222,"I",0,80,"2122-10-24T15:20","2122-10-31T16:20"],[223,"I",0,86,"2122-10-24T15:20","2122-10-31T16:20"],[224,"I",0,16,"2122-10-24T15:20","2122-10-31T16:20"],[225,"I",0,400,"2122-10-24T15:20","2122-10-31T16:20"],[226,"I",0,1500,"2122-10-24T15:20","2122-10-31T16:20"],[227,"I",0,1400,"2122-10-24T15:20","2122-10-31T16:20"],[228,"I",0,0,"2122-10-24T15:20","2122-10-31T16:20"],[229,"I",-1,398,"2122-10-24T15:20","2122-10-31T16:20"],[230,"I",1,1499,"2122-10-24T15:20","2122-10-31T16:20"],[231,"I",0,1400,"2122-10-24T15:20","2122-10-31T16:20"],[232,"I",0,348,"2122-10-24T15:20","2122-10-31T16:20"],[233,"I",0,300,"2122-10-24T15:20","2122-10-31T16:20"],[234,"I",0,2000,"2122-10-24T15:20","2122-10-31T16:20"],[235,"I",0,8000,"2123-03-06T17:00","2123-09-30T19:00"],[236,"I",0,200,"2122-10-24T15:20","2122-10-31T16:20"],[237,"I",0,1000,"2122-10-24T15:20","2122-10-31T16:20"],[238,"I",18678,20000,"2023-03-06T17:00","2023-09-30T19:00"],[239,"I",0,29,"2122-10-24T15:20","2122-10-31T16:20"],[240,"I",0,109,"2122-10-24T15:20","2122-10-31T16:20"],[241,"I",0,71,"2122-10-24T15:20","2122-10-31T16:20"],[242,"I",0,80,"2122-10-24T15:20","2122-10-31T16:20"],[243,"I",0,33,"2122-10-24T15:20","2122-10-31T16:20"],[244,"I",0,105,"2122-10-24T15:20","2122-10-31T16:20"],[248,"I",0,8,"2122-10-24T15:20","2122-10-31T16:20"],[249,"I",0,70,"2122-10-24T15:20","2122-10-31T16:20"],[250,"I",0,33,"2122-10-24T15:20","2122-10-31T16:20"],[251,"I",0,68,"2122-10-24T15:20","2122-10-31T16:20"],[252,"I",0,52,"2122-10-24T15:20","2122-10-31T16:20"],[253,"I",0,103,"2122-10-24T15:20","2122-10-31T16:20"],[254,"I",0,91,"2122-10-24T15:20","2122-10-31T16:20"],[255,"I",0,81,"2122-10-24T15:20","2122-10-31T16:20"],[256,"I",0,15,"2122-10-24T15:20","2122-10-31T16:20"],[257,"I",0,115,"2122-10-24T15:20","2122-10-31T16:20"],[258,"I",0,83,"2122-10-24T15:20","2122-10-31T16:20"],[259,"I",0,14,"2122-10-24T15:20","2122-10-31T16:20"],[260,"I",0,82,"2122-10-24T15:20","2122-10-31T16:20"],[261,"I",0,182,"2122-10-24T15:20","2122-10-31T16:20"],[262,"I",0,94,"2122-10-24T15:20","2122-10-31T16:20"],[263,"I",0,25,"2122-10-24T15:20","2122-10-31T16:20"],[264,"I",0,20,"2122-10-24T15:20","2122-10-31T16:20"],[265,"I",0,53,"2122-10-24T15:20","2122-10-31T16:20"],[266,"I",0,234,"2122-10-24T15:20","2122-10-31T16:20"],[270,"I",0,31,"2122-10-24T15:20","2122-10-31T16:20"],[271,"I",0,106,"2122-10-24T15:20","2122-10-31T16:20"],[272,"I",0,153,"2122-10-24T15:20","2122-10-31T16:20"],[273,"I",0,114,"2122-10-24T15:20","2122-10-31T16:20"],[274,"I",0,27,"2122-10-24T15:20","2122-10-31T16:20"],[275,"I",0,72,"2122-10-24T15:20","2122-10-31T16:20"],[276,"I",0,23,"2122-10-24T15:20","2122-10-31T16:20"],[278,"I",0,33,"2122-10-24T15:20","2122-10-31T16:20"],[279,"I",0,96,"2122-10-24T15:20","2122-10-31T16:20"],[280,"I",0,10,"2122-10-24T15:20","2122-10-31T16:20"],[281,"I",0,106,"2122-10-24T15:20","2122-10-31T16:20"],[286,"I",0,0,"2122-10-24T15:20","2122-10-31T16:20"],[287,"I",0,1,"2122-10-24T15:20","2122-10-31T16:20"],[288,"I",0,61,"2122-10-24T15:20","2122-10-31T16:20"],[289,"I",0,77,"2122-10-24T15:20","2122-10-31T16:20"],[293,"I",0,800,"2122-04-24T16:00","2122-05-09T16:30"],[294,"I",0,0,"2122-04-24T16:00","2122-05-09T16:30"],[295,"I",0,22,"2122-10-24T15:20","2122-10-31T16:20"],[296,"I",0,108,"2122-10-24T15:20","2122-10-31T16:20"],[297,"I",0,800,"2023-04-24T16:00","2023-05-09T16:30"],[298,"I",0,5000,"2023-04-24T18:00","2023-05-09T16:30"],[299,"I",0,50000,"2122-04-24T16:00","2122-05-09T16:30"],[300,"I",0,65,"2122-10-24T15:20","2122-10-31T16:20"],[301,"I",0,117,"2122-10-24T15:20","2122-10-31T16:20"],[304,"I",0,99,"2122-10-24T15:20","2122-10-31T16:20"],[305,"I",0,62,"2122-10-24T15:20","2122-10-31T16:20"],[306,"I",0,99,"2122-10-24T15:20","2122-10-31T16:20"],[307,"I",0,63,"2122-10-24T15:20","2122-10-31T16:20"],[308,"I",0,48,"2122-10-24T15:20","2122-10-31T16:20"],[309,"I",0,132,"2122-10-24T15:20","2122-10-31T16:20"],[312,"I",0,33,"2122-10-24T15:20","2122-10-31T16:20"],[313,"I",0,99,"2122-10-24T15:20","2122-10-31T16:20"],[316,"I",0,157,"2122-10-24T15:20","2122-10-31T16:20"],[317,"I",0,50,"2122-10-24T15:20","2122-10-31T16:20"],[318,"I",0,63,"2122-10-24T15:20","2122-10-31T16:20"],[319,"I",0,102,"2122-10-24T15:20","2122-10-31T16:20"],[323,"I",0,579,"2122-10-24T15:20","2122-10-31T16:20"],[324,"I",0,107,"2122-10-24T15:20","2122-10-31T16:20"],[325,"I",0,18,"2122-10-24T15:20","2122-10-31T16:20"],[326,"I",0,10000,"2122-05-15T17:00","2122-05-19T17:00"],[327,"I",0,10000,"2122-05-15T17:00","2122-05-19T17:00"],[328,"I",0,3,"2122-10-24T15:20","2122-10-31T16:20"],[329,"I",0,76,"2122-10-24T15:20","2122-10-31T16:20"],[330,"I",0,16,"2122-10-24T15:20","2122-10-31T16:20"],[331,"I",0,95,"2122-10-24T15:20","2122-10-31T16:20"],[332,"I",0,105,"2122-10-24T15:20","2122-10-31T16:20"],[333,"I",0,127,"2122-10-24T15:20","2122-10-31T16:20"],[338,"I",0,123,"2122-10-24T15:20","2122-10-31T16:20"],[339,"I",0,0,"2122-10-24T15:20","2122-10-31T16:20"],[340,"I",0,74,"2122-10-24T15:20","2122-10-31T16:20"],[341,"I",0,148,"2122-10-24T15:20","2122-10-31T16:20"],[342,"I",0,59,"2122-10-24T15:20","2122-10-31T16:20"],[343,"I",0,146,"2122-10-24T15:20","2122-10-31T16:20"],[344,"I",0,10000,"2122-10-24T15:20","2122-10-31T16:20"],[345,"I",0,205,"2122-10-24T15:20","2122-10-31T16:20"],[346,"I",0,129,"2122-10-24T15:20","2122-10-31T16:20"],[347,"I",0,186,"2122-10-24T15:20","2122-10-31T16:20"],[348,"I",0,104,"2122-10-24T15:20","2122-10-31T16:20"],[349,"I",0,61,"2122-10-24T15:20","2122-10-31T16:20"],[350,"I",0,117,"2122-10-24T15:20","2122-10-31T16:20"],[351,"I",0,27,"2122-10-24T15:20","2122-10-31T16:20"],[352,"I",0,113,"2122-10-24T15:20","2122-10-31T16:20"],[353,"I",0,9,"2122-10-24T15:20","2122-10-31T16:20"],[354,"I",0,11,"2122-10-24T15:20","2122-10-31T16:20"],[355,"I",0,62,"2122-10-24T15:20","2122-10-31T16:20"],[356,"I",0,134,"2122-10-24T15:20","2122-10-31T16:20"],[357,"I",0,142,"2122-10-24T15:20","2122-10-31T16:20"],[360,"I",0,85,"2122-10-24T15:20","2122-10-31T16:20"],[361,"I",0,91,"2122-10-24T15:20","2122-10-31T16:20"],[362,"I",0,196,"2122-10-24T15:20","2122-10-31T16:20"],[363,"I",0,205,"2122-10-24T15:20","2122-10-31T16:20"],[364,"I",0,48,"2122-10-24T15:20","2122-10-31T16:20"],[365,"I",0,137,"2122-10-24T15:20","2122-10-31T16:20"],[366,"I",0,99,"2122-10-24T15:20","2122-10-31T16:20"],[367,"I",0,134,"2122-10-24T15:20","2122-10-31T16:20"],[370,"I",0,113,"2122-10-24T15:20","2122-10-31T16:20"],[371,"I",0,135,"2122-10-24T15:20","2122-10-31T16:20"],[374,"I",0,56,"2122-10-24T15:20","2122-10-31T16:20"],[375,"I",0,89,"2122-10-24T15:20","2122-10-31T16:20"],[376,"I",0,23,"2122-10-24T15:20","2122-10-31T16:20"],[377,"I",0,315,"2122-10-24T15:20","2122-10-31T16:20"],[378,"I",0,83,"2122-10-24T15:20","2122-10-31T16:20"],[379,"I",0,18,"2122-10-24T15:20","2122-10-31T16:20"],[383,"I",0,68,"2122-10-24T15:20","2122-10-31T16:20"],[384,"I",0,95,"2122-10-24T15:20","2122-10-31T16:20"],[385,"I",0,52,"2122-10-24T15:20","2122-10-31T16:20"],[386,"I",0,96,"2122-10-24T15:20","2122-10-31T16:20"],[390,"I",0,77,"2122-10-24T15:20","2122-10-31T16:20"],[391,"I",0,92,"2122-10-24T15:20","2122-10-31T16:20"],[392,"I",0,51,"2122-10-24T15:20","2122-10-31T16:20"],[393,"I",0,95,"2122-10-24T15:20","2122-10-31T16:20"],[397,"I",0,75,"2122-10-24T15:20","2122-10-31T16:20"],[398,"I",0,94,"2122-10-24T15:20","2122-10-31T16:20"],[399,"I",0,22,"2122-10-24T15:20","2122-10-31T16:20"],[400,"I",0,28488,"2122-10-24T15:20","2122-10-31T16:20"],[401,"I",0,0,"2122-10-24T15:20","2122-10-31T16:20"],[402,"I",0,54,"2122-10-24T15:20","2122-10-31T16:20"],[403,"I",0,0,"2122-10-24T15:20","2122-10-31T16:20"],[404,"I",0,90,"2122-10-24T15:20","2122-10-31T16:20"],[405,"I",0,29,"2122-10-24T15:20","2122-10-31T16:20"]]'::jsonb) AS r
   WHERE pd.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid
     AND pd.dist_id = r->>0;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 224 THEN RAISE EXCEPTION 'expected 224 Golazos dists updated, got %', n; END IF;
END $g$;
