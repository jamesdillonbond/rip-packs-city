-- audit_20260830_pause_jobid_16_pack_pool_backfill_while_its_host_is_dead
--
-- WHY: pg_cron jobid 16 `rpc-backfill-pack-pool` (every 5 min) dispatches backfill-topshot-pack-supply?mode=pool, whose
-- pool walk lives on public-api.nbatopshot.com -- Cloudflare 530/1033 since 2026-08-28 ~17Z (decommissioning-shaped; see
-- inbox 2026-08-29T1630Z). Measured 24 h to 02:2xZ: 277 runs, 0 ok, 0 rows written, 283 busy-minutes. Each run FIRST runs
-- get_topshot_pool_backfill_targets() against the DB: pg_stat_statements 3,559 calls, mean 9,570 ms, 1,565 disk reads/call
-- (~44 DB-minutes and ~430k disk reads a day on an IO-bound instance) before dying at the dead host. The 08-29 alerts show it
-- as 477/703 failed (HIGH) -- noise that trains the reader to skim.
--
-- WHAT: cron.alter_job(16, active => false). Nothing else changes; the job, schedule and command are preserved for the
-- re-enable. No watchlist row exists for topshot-pack-pool-backfill, so this pause is INVISIBLE to detect_stalled_pipelines()
-- by construction -- which is why the exit condition is written here and in the ledger, not left to an arm.
--
-- EXIT CONDITION (re-enable): `curl -s -o /dev/null -w '%{http_code}' https://public-api.nbatopshot.com/graphql` returns
-- anything other than 530/503 for two consecutive checks, OR backfill-topshot-pack-supply is ported off that host.
-- REVERT: SELECT cron.alter_job(16, active => true);

DO $mig$
DECLARE r record;
BEGIN
  SELECT jobid, jobname, schedule, username, active, command INTO r FROM cron.job WHERE jobid = 16;
  IF r.jobid IS NULL OR r.jobname <> 'rpc-backfill-pack-pool' OR r.username <> 'postgres' OR r.active IS NOT TRUE
     OR r.command NOT LIKE '%backfill-topshot-pack-supply?key=%mode=pool%' THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: jobid 16 is not the active postgres-owned rpc-backfill-pack-pool pool dispatcher (got % / % / active=%)', r.jobname, r.username, r.active;
  END IF;
  PERFORM cron.alter_job(16, active => false);
  IF (SELECT active FROM cron.job WHERE jobid = 16) IS NOT FALSE THEN
    RAISE EXCEPTION 'POST-STATE FAILED: jobid 16 still active';
  END IF;
  RAISE NOTICE 'jobid 16 rpc-backfill-pack-pool paused (schedule % preserved)', r.schedule;
END
$mig$;