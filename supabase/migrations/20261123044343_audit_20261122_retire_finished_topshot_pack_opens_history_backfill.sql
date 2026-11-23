-- audit_20261122_retire_finished_topshot_pack_opens_history_backfill
--
-- 2026-11-22 ~8:45 PM PT (Claude Code cloud, autonomous pass; lane budget, strategy-2026-11-22.md Move 4).
-- pg_cron job 56 `rpc-topshot-pack-opens-history` (`11,26,41,56 * * * *`) calls the edge function
-- ingest-topshot-pack-opens-history?mode=backfill. Its cursor has sat at the floor (65264619) since ~08-01, so every
-- run logs `done: true`, rows_found 0, rows_written 0: 10,972 runs, 0 rows ever written (pipeline_runs_daily since
-- 07-29), 96 edge invocations a day. Pre-mainnet27 heights are unreachable anyway (#181), so the floor cannot move.
-- No SQL function references the lane; lib/sentinel/zero-yield.ts already names it as a "finished backfill" zero.
--
-- HOW (the 20261119080000 pattern; reversible, nothing deleted):
--   * cron.alter_job(56, active := false) -- the job keeps its command and gate key.
--   * its pipeline_cadence_watchlist row -> is_active = false (backed up), so a stopped lane does not read as SILENT.
-- Active pg_cron jobs 319 -> 318.
--
-- REVERT:
--   SELECT cron.alter_job(job_id := 56, active := true);
--   UPDATE public.pipeline_cadence_watchlist w SET is_active = b.is_active, notes = b.notes
--     FROM public.audit_20261122_pack_opens_history_watchlist_backup b WHERE w.pipeline = b.pipeline;

CREATE TABLE IF NOT EXISTS public.audit_20261122_pack_opens_history_watchlist_backup AS
SELECT now() AS backed_up_at, w.* FROM public.pipeline_cadence_watchlist w
 WHERE w.pipeline = 'topshot-pack-opens-history-backfill';
ALTER TABLE public.audit_20261122_pack_opens_history_watchlist_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_20261122_pack_opens_history_watchlist_backup FROM PUBLIC, anon, authenticated;

DO $guard$
BEGIN
  IF (SELECT count(*) FROM cron.job WHERE jobid = 56 AND jobname = 'rpc-topshot-pack-opens-history' AND active) <> 1 THEN
    RAISE EXCEPTION 'expected active job 56 rpc-topshot-pack-opens-history';
  END IF;
END $guard$;

SELECT cron.alter_job(job_id := 56, active := false);

UPDATE public.pipeline_cadence_watchlist
   SET is_active = false,
       notes = coalesce(notes, '') || ' | RETIRED 2026-11-22: backfill finished (cursor at its floor 65264619, done=true on every run since ~08-01); pg_cron job 56 paused by audit_20261122_retire_finished_topshot_pack_opens_history_backfill.'
 WHERE pipeline = 'topshot-pack-opens-history-backfill';
