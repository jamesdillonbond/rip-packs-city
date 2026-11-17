-- audit_20261115_reprice_drifted_rips_floor_50
--
-- pg_cron jobid 810 (rpc-reprice-drifted-high-value-rips, 4:26 AM PT daily) now calls
-- reprice_drifted_high_value_rips(50, 1.5) instead of (100, 1.5): rips stored at >= $50 (was >= $100)
-- are re-priced to current FMV once they drift past 1.5x.
--
-- WHY (Trevor, 2026-11-15 ~12:30 PM PT: "Set the floor to $50"). Measured 11-14 6:56 AM PT: one real run of
-- (50, 1.5) = 14,151 candidates in 33.2 s (~1/3 of the ~120 s ceiling), 2,050 re-priced. Rips 2026-11:
-- 6,762 >= $100 vs 14,395 >= $50 (TS + AD). Below $50 stays on backfill_pack_rip_metadata's stale leg.
-- Function body unchanged (md5 79809e4b2ded642912963cd8a5e93c18, asserted); only the job's arguments.
-- Job owner is postgres, so cron.alter_job is callable here.
-- anon-exec: n/a (no function created or replaced).
-- Revert: SELECT cron.alter_job(810, command := 'SELECT public.reprice_drifted_high_value_rips(100, 1.5);');
DO $guard$
BEGIN
  IF (SELECT count(*) FROM cron.job WHERE jobid = 810 AND username = 'postgres'
        AND command = 'SELECT public.reprice_drifted_high_value_rips(100, 1.5);') <> 1 THEN
    RAISE EXCEPTION 'jobid 810 is not the expected postgres-owned (100, 1.5) reprice job; re-read before changing';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reprice_drifted_high_value_rips(numeric, numeric)'::regprocedure)
     <> '79809e4b2ded642912963cd8a5e93c18' THEN
    RAISE EXCEPTION 'reprice_drifted_high_value_rips changed; re-read before re-pointing its job';
  END IF;
END $guard$;

SELECT cron.alter_job(810, command := 'SELECT public.reprice_drifted_high_value_rips(50, 1.5);');

DO $post$
BEGIN
  IF (SELECT count(*) FROM cron.job WHERE command ILIKE '%reprice_drifted_high_value_rips%') <> 1
     OR (SELECT command FROM cron.job WHERE jobid = 810) <> 'SELECT public.reprice_drifted_high_value_rips(50, 1.5);'
     OR (SELECT username FROM cron.job WHERE jobid = 810) <> 'postgres' THEN
    RAISE EXCEPTION 'post-check failed: jobid 810 not re-pointed cleanly';
  END IF;
END $post$;
