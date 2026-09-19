-- audit_20260919_r101_v2b_atlas_listing_tick_keeps_its_temp_objects_in_memory_bounded
--
-- R101 v2b. Companion to 20260919152824 (R101 v2), applied ~40 min later once its first
-- post-change reading was in. Separate migration so it can be reverted on its own.
--
-- MEASURED after v2 (pg_stat_statements delta, queryid -3354316985779850203, 4 completed ticks,
-- 15:28Z-15:5xZ, against the 6,951-call pre figure and the register's same-instrument pre-window
-- of ~871k-903k blocks/call): blocks touched/call 927,297 -> 542,527 (-41%), physical reads/call
-- 26,438 -> 19,112 (-28%), BUT temp blocks WRITTEN per call 3,998 -> 6,776 (+70%). Sized in a
-- scratch session at 8:5x AM PT: _open24 = 10,240 kB, _tsl_want = 10,240 kB, _cl_want = 25,088 kB
-- (56,554 open rows), the DISTINCT ON sorts ~13 MB each (external merge on disk at the current
-- work_mem = 5 MB), and the two delta-first hash tables (~12 MB, ~20 MB) exceed 2 x work_mem so
-- they batch to disk too. temp_buffers is 8 MB, so all three temp tables spill.
-- => ~53 MB written + read back per tick of TEMP FILE traffic on the same disk the 22 MB/s IO
--    budget covers; at 720 ticks/day that is ~76 GB/day of the lane's disk cost, and it is the
--    part of this lane that actually competes with user reads. Post-v2 the tick still dies at
--    120 s inside `_open24` / `_tsl_want` under the spell -- temp spill IO is on that path.
--
-- WHAT THIS DOES (a bounded memory grant on ONE backend, the pg_cron job's, for <= ~60 s every 2 min):
--   * atlas_listing_verify_tick: temp_buffers = '48MB' -- covers 10 + 10 + 25 MB of temp tables
--     that coexist in the tick's transaction. temp_buffers must be set before the session's first
--     temp-table use; the tick is the FIRST thing a fresh pg_cron session runs and creates the
--     first temp table itself, so the function-attached SET takes effect. Allocated lazily, page
--     by page, and freed when the pg_cron session ends after the run.
--   * the three sync functions: work_mem = '16MB' -- the 13 MB quicksort fits, and with
--     hash_mem_multiplier = 2 the delta-first hash tables (32 MB budget) fit too.
--   Peak: ~48 + 16 (one sort at a time) MB on one backend. The 09-18 R101 v1 grant (64 MB +
--   3 x 48 MB) was declined as unmeasured; this one is sized from the measured objects above,
--   is ~40% of that, and is the only lever left for this lane's TEMP traffic short of shrinking
--   the wanted set (read-side incrementality, still open in the register).
--
-- ONLY CALLER: cron.job 466 (rpc-ts-listings-atlas-sync, postgres, */2). No PostgREST or repo
-- caller of any of the four functions (grepped app/ lib/ scripts/ workers/ .github/ supabase/functions/
-- and cron.job.command). A pooled PostgREST session that had already used temp tables would
-- refuse a temp_buffers change -- no such caller exists, and the pins run standalone in a fresh
-- psql session where the setting is irrelevant to the assertions.
--
-- Function-attached SETs do not change prosrc, so the DB-invariant pins (which compare bodies)
-- are unaffected; `check_secdef_anon_exec_drift()` re-checked after (0). NO body change.
--
-- MEASUREMENT CONTRACT: pg_stat_statements temp_blks_written / calls for the tick queryid over a
-- wholly-post window -> expected to fall from 6,776 toward ~0; blocks touched/call should hold at
-- the v2 level (~540k). Change-point counters at apply (16:00:33Z): calls 6,957,
-- temp_blks_written 27,833,889, shared hit+read 6,448,130,088. FALSIFIER: temp_blks_written/call
-- not down >= 80% => the grant is not reaching the spills (setting scope wrong); revert.
--
-- REVERT: ALTER FUNCTION public.atlas_listing_verify_tick(integer) RESET temp_buffers;
--         ALTER FUNCTION public.sync_ts_listings_from_atlas(boolean) RESET work_mem;
--         ALTER FUNCTION public.sync_cached_listings_from_atlas() RESET work_mem;
--         ALTER FUNCTION public.sync_edition_offers_from_atlas() RESET work_mem;

DO $guard$
BEGIN
  IF (SELECT count(*) FROM cron.job WHERE command ILIKE '%atlas_listing_verify_tick%') <> 1 THEN
    RAISE EXCEPTION 'expected exactly one cron caller of atlas_listing_verify_tick';
  END IF;
  IF (SELECT proconfig FROM pg_proc WHERE proname = 'atlas_listing_verify_tick' AND pronamespace = 'public'::regnamespace)
       <> ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION 'atlas_listing_verify_tick already carries a non-search_path SET — re-read before layering another';
  END IF;
END $guard$;

ALTER FUNCTION public.atlas_listing_verify_tick(integer) SET temp_buffers = '48MB';
ALTER FUNCTION public.sync_ts_listings_from_atlas(boolean) SET work_mem = '16MB';
ALTER FUNCTION public.sync_cached_listings_from_atlas() SET work_mem = '16MB';
ALTER FUNCTION public.sync_edition_offers_from_atlas() SET work_mem = '16MB';

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'atlas_listing_verify_tick' AND pronamespace = 'public'::regnamespace
                   AND 'temp_buffers=48MB' = ANY (proconfig)) THEN
    RAISE EXCEPTION 'temp_buffers grant did not land on atlas_listing_verify_tick';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
        AND proname IN ('sync_ts_listings_from_atlas','sync_cached_listings_from_atlas','sync_edition_offers_from_atlas')
        AND 'work_mem=16MB' = ANY (proconfig)) <> 3 THEN
    RAISE EXCEPTION 'work_mem grant did not land on all three sync functions';
  END IF;
END $post$;
