-- audit_20260918_atlas_listing_tick_keeps_the_open_book_in_local_memory
--
-- Follow-through on 20260919012821 (R101), twenty minutes after it applied, from a probe
-- of the mechanism it introduced. `_open24` is 62k rows x 361 bytes = 3,328 local pages
-- (26 MB), and a session's local buffer pool is `temp_buffers` = 8 MB by default. So each
-- of the three consumers that READ `_open24` paid `local read=3328 written=1007` per read
-- (EXPLAIN ANALYZE, BUFFERS, 6:4x PM PT) — the table was being evicted to and re-read from
-- temp files on the one resource this database is short of, three times per tick, which
-- is the cost the migration set out to remove. With `temp_buffers = '64MB'` the same read
-- is `local hit=3328`, no local read, no local write, no temp file.
--
-- WHY ON THE TICK, NOT ON THE SYNC FUNCTION: `temp_buffers` can be changed in a session
-- only BEFORE its first use of a temporary table, and the pool is sized at that first use.
-- A SET attached to a function is applied on entry and reverted on exit, so it must sit
-- on the outermost function of the pg_cron statement — atlas_listing_verify_tick — which
-- is entered before any temp table exists in that fresh connection and stays entered for
-- all three consumers. The standalone callers (the pin tests, a manual sync) keep the
-- default and keep working; they build the same table, they just may spill.
--
-- Cost: at most 64 MB of local buffers in ONE backend while the tick runs (allocated as
-- needed, 26 MB today), on a 2 GB instance. The tick is not a pinned function; this is a
-- config-only ALTER (proconfig), no body write.
--
-- REVERT: ALTER FUNCTION public.atlas_listing_verify_tick(integer) RESET temp_buffers;

ALTER FUNCTION public.atlas_listing_verify_tick(integer) SET temp_buffers = '64MB';

DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'atlas_listing_verify_tick'
                    AND p.proconfig @> ARRAY['temp_buffers=64MB']) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: temp_buffers not attached to atlas_listing_verify_tick';
  END IF;
END
$mig$;
