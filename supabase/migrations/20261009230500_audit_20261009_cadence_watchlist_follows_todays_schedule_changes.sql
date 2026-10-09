-- audit_20261009_cadence_watchlist_follows_todays_schedule_changes
--
-- ⏸ STATUS 2026-10-09 ~4:00 PM PT: NOT YET APPLIED. apply_migration was HELD by the Supabase MCP's
-- human-confirmation gate (60 s timeout, nothing landed: re-read after). Per tooling-gotchas.md the
-- file is committed and the statements go to Trevor: paste this whole file into the Supabase SQL
-- editor. Both UPDATEs are guarded, so a late-landing held write or a second paste is a no-op.
-- After it lands, rename this file to the version supabase_migrations.schema_migrations records (if
-- applied via the editor, none is recorded; leave the name). Verify by READ:
--   select pipeline, is_active, max_silent_minutes from pipeline_cadence_watchlist
--    where pipeline in ('ingest-pinnacle-mints-backfill','pinnacle-fmv-recalc');
--   -> false / 60 and true / 400; detect_stalled_pipelines() no longer lists ingest-pinnacle-mints-backfill.
--
-- Two pipeline_cadence_watchlist rows went stale when 20261009195532 changed schedules today
-- (the same class as 20260906213209: a watch row that outlives its schedule is a permanently-red arm).
--
-- 1. `ingest-pinnacle-mints-backfill` — jobid 84 was DEACTIVATED today (spork floor, 0 rows since
--    09-29). By 3:57 PM PT detect_stalled_pipelines() already read it "silent 184 min (info)".
--    Retired here (is_active=false, note kept). It has a zero-yield suppression with the same reason.
--
-- 2. `pinnacle-fmv-recalc` — its bars (silent 1,560 min / no-success 3,120 min) were sized for the
--    old twice-daily cadence. The full recalc now runs every 3 h (`37 1-22/3 * * *`, plus the
--    cron-job.org 10:07Z call), and the first 3-hourly run landed 3:37 PM PT (ok, 9.7 s). At 26 h a
--    dead recompute would go unnoticed for a day; 400 min = two missed ticks plus slack, 800 min
--    without success. Severity unchanged (medium).
--
-- REVERT:
--   UPDATE public.pipeline_cadence_watchlist SET is_active = true WHERE pipeline = 'ingest-pinnacle-mints-backfill';
--   UPDATE public.pipeline_cadence_watchlist SET max_silent_minutes = 1560, max_minutes_without_success = 3120
--    WHERE pipeline = 'pinnacle-fmv-recalc';

UPDATE public.pipeline_cadence_watchlist
   SET is_active = false,
       notes = COALESCE(notes, '') || ' | RETIRED 2026-10-09: jobid 84 rpc-pinnacle-mints-backfill deactivated by 20261009195532 (spork floor; 0 rows since 09-29). The forward lane (ingest-pinnacle-mints-forward) carries the live mints.'
 WHERE pipeline = 'ingest-pinnacle-mints-backfill' AND is_active;

UPDATE public.pipeline_cadence_watchlist
   SET max_silent_minutes = 400,
       max_minutes_without_success = 800,
       notes = COALESCE(notes, '') || ' | 2026-10-09: bars 1560/3120 -> 400/800 min for the 3-hourly schedule (37 1-22/3 * * *, 20261009195532).'
 WHERE pipeline = 'pinnacle-fmv-recalc' AND max_silent_minutes = 1560;

DO $$
BEGIN
  IF (SELECT is_active FROM public.pipeline_cadence_watchlist WHERE pipeline = 'ingest-pinnacle-mints-backfill') THEN
    RAISE EXCEPTION 'ingest-pinnacle-mints-backfill watch row still active';
  END IF;
  IF (SELECT max_silent_minutes FROM public.pipeline_cadence_watchlist WHERE pipeline = 'pinnacle-fmv-recalc') <> 400 THEN
    RAISE EXCEPTION 'pinnacle-fmv-recalc bars not tightened';
  END IF;
END $$;
