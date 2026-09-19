-- audit_20260919_r101_v2c_the_cached_listings_sort_is_the_last_temp_spill
--
-- R101 v2c. Completes 20260919160033 (v2b), whose own contract MISSED as written and said why:
-- temp_blks_written/call for the tick (queryid -3354316985779850203) fell 7,740 -> 2,899 over the
-- first 7 completed v2b ticks (-62 %, against the >= 80 % the contract demanded). The residual is
-- ONE statement, measured rather than guessed (EXPLAIN ANALYZE, BUFFERS, in a scratch session with
-- SET work_mem = '16MB', _open24 built first so the production branch runs): the `_cl_want`
-- DISTINCT ON sort in sync_cached_listings_from_atlas is still `Sort Method: external merge
-- Disk: 23472kB`, temp written 2,935 blocks -- i.e. the whole remaining 2,899/call. Its input rows
-- carry thumbnail_url + buy_url + set_name, so the 57k-row sort is ~23 MB where _tsl_want's is ~13.
--
-- WHAT THIS DOES: work_mem 16MB -> 32MB on sync_cached_listings_from_atlas ONLY (+16 MB, one
-- pg_cron backend, for the seconds that sort runs). Blocks/call after v2b: 145,392 (was 927,297).
-- Nothing else moves. The two other syncs keep 16MB (their sorts fit).
--
-- CONTRACT: temp_blks_written/call over a wholly-post window -> ~0 (the 48 MB temp_buffers grant on
-- the tick already holds the three temp tables). Change-point counters at apply (16:29:27Z):
-- calls 6,965 · shared hit+read 6,449,286,716 · temp_blks_written 27,857,104.
-- FALSIFIER: still > 500/call at n >= 10 => another spill exists; EXPLAIN the remaining statements
-- the same way before granting anything more.
--
-- REVERT: ALTER FUNCTION public.sync_cached_listings_from_atlas() SET work_mem = '16MB';  (v2b value)

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'sync_cached_listings_from_atlas'
                   AND pronamespace = 'public'::regnamespace AND 'work_mem=16MB' = ANY (proconfig)) THEN
    RAISE EXCEPTION 'sync_cached_listings_from_atlas does not carry the v2b work_mem=16MB — re-read before layering';
  END IF;
END $guard$;

ALTER FUNCTION public.sync_cached_listings_from_atlas() SET work_mem = '32MB';

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'sync_cached_listings_from_atlas'
                   AND pronamespace = 'public'::regnamespace AND 'work_mem=32MB' = ANY (proconfig)) THEN
    RAISE EXCEPTION 'work_mem=32MB did not land';
  END IF;
END $post$;
