-- audit_20261114_reprice_drifted_rips_at_1_5x
--
-- pg_cron jobid 810 (rpc reprice-drifted-rips, 4:26 AM PT daily) now calls
-- reprice_drifted_high_value_rips(100, 1.5) instead of the defaults (100, 3).
--
-- WHY (Trevor, 2026-11-14 ~5:20 AM PT: "Keep going and do that"). pack_rips.pull_value_usd is contractually
-- CURRENT FMV (20260913032000; 20261031000741 header), but a rip is re-priced daily only past a 3x drift.
-- Found 11-13 night: two LeBron James — Run It Back: Origins ::23 rips stored $950 against a current
-- $429.68 (2.2x — never corrected), so the binder's "Pull value" and "Held FMV" disagreed on the same moment.
-- Measured 11-14 5:25 AM PT, Top Shot rips stored >= $100 with a fully priced pull (6,152): 0 past 3x,
-- 1,397 past 1.5x, 2,506 past 1.25x. 1.5x catches the stale ones without re-writing ordinary FMV wobble daily.
-- The function body is unchanged (md5 79809e4b2ded642912963cd8a5e93c18, asserted); only the job's arguments.
-- Job owner is postgres, so cron.alter_job is callable here (not the cron_heavy pincer).
-- anon-exec: n/a (no function created or replaced).
-- Revert: SELECT cron.alter_job(810, command := 'SELECT public.reprice_drifted_high_value_rips();');
DO $guard$
BEGIN
  IF (SELECT count(*) FROM cron.job WHERE jobid = 810 AND username = 'postgres'
        AND command = 'SELECT public.reprice_drifted_high_value_rips();') <> 1 THEN
    RAISE EXCEPTION 'jobid 810 is not the expected postgres-owned reprice job with default arguments; re-read before changing';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reprice_drifted_high_value_rips(numeric, numeric)'::regprocedure)
     <> '79809e4b2ded642912963cd8a5e93c18' THEN
    RAISE EXCEPTION 'reprice_drifted_high_value_rips changed; re-read before re-pointing its job';
  END IF;
END $guard$;

SELECT cron.alter_job(810, command := 'SELECT public.reprice_drifted_high_value_rips(100, 1.5);');

DO $post$
BEGIN
  IF (SELECT count(*) FROM cron.job WHERE command ILIKE '%reprice_drifted_high_value_rips%') <> 1
     OR (SELECT command FROM cron.job WHERE jobid = 810) <> 'SELECT public.reprice_drifted_high_value_rips(100, 1.5);'
     OR (SELECT username FROM cron.job WHERE jobid = 810) <> 'postgres' THEN
    RAISE EXCEPTION 'post-check failed: jobid 810 not re-pointed cleanly';
  END IF;
END $post$;
