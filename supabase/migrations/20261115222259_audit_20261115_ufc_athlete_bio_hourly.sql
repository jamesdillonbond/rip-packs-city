-- audit_20261115_ufc_athlete_bio_hourly
--
-- WHY (Claude Code cloud, 2026-11-15 ~2:22 PM PT). rpc-ufc-athlete-bio (job 842) was scheduled every 20 seconds by
-- 20261108224008 to crawl UFC.com one athlete page per tick (robots.txt crawl-delay 15). The crawl FINISHED 11-08
-- 5:14 PM PT: ufc_athlete_bio = 370 ok / 15 not_found / 1 error, 0 pending / queued. Since then every tick re-runs
-- the players -> ufc_athlete_bio seed (insert ... on conflict do nothing) and finds nothing to dispatch:
-- pgss 29,688 calls, 3,037 blocks/call (~13M buffer touches a day), 4,320 cron.job_run_details rows a day, and it
-- holds a pg_cron worker slot every 20 s (one "job startup timeout" 11-15 11:36 AM PT). UFC Strike is retired, so new
-- players are rare; hourly still fetches a new one within the hour (one dispatch per tick, its response drained the
-- next tick). Body unchanged.
--
-- REVERT: select cron.alter_job((select jobid from cron.job where jobname = 'rpc-ufc-athlete-bio'), schedule := '20 seconds');

DO $$
DECLARE
  j bigint;
BEGIN
  SELECT jobid INTO j FROM cron.job WHERE jobname = 'rpc-ufc-athlete-bio' AND schedule = '20 seconds';
  IF j IS NULL THEN RAISE EXCEPTION 'rpc-ufc-athlete-bio not found at 20 seconds; re-read before changing'; END IF;
  IF EXISTS (SELECT 1 FROM public.ufc_athlete_bio WHERE status IN ('pending', 'queued')) THEN
    RAISE EXCEPTION 'ufc_athlete_bio still has pending/queued rows; the crawl is not finished';
  END IF;
  PERFORM cron.alter_job(j, schedule := '43 * * * *');
END $$;
