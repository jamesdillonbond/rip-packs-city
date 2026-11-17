-- audit_20260823_series_rollup_cron_schedule
--
-- Schedules the hourly refresh. Recorded as a migration so the repo and the DB
-- agree; `cron.schedule` with an existing NAME updates IN PLACE and preserves
-- the jobid, so re-running this is idempotent. ⚠ Never `cron.unschedule` first
-- — that churns the jobid and every note that cites it goes stale.
--
-- ⚠ `SET LOCAL ROLE cron_heavy` is load-bearing. The job must be OWNED by
-- cron_heavy to inherit its 600 s `rolconfig` statement_timeout; scheduled as
-- postgres it would take the default and be killed mid-refresh. Verified after:
-- jobid 357, username cron_heavy, rolconfig {statement_timeout=600s}.
--
-- ── WHY MINUTE 59 ───────────────────────────────────────────────────────────
-- Chosen by elimination against every active schedule, not by preference.
-- `job startup timeout` is 67-80% of all pg_cron failures here
-- (max_worker_processes = 6 vs cron.max_running_jobs = 32) and it writes
-- NOTHING to pipeline_runs, so a collision is invisible tick loss.
--
-- Ruled out: every explicit minute already in cron.job; `*/2` (so no even
-- minute); `*/3` and `1-58/3`; `2-59/5` and `3,8,…,58`; `2-58/4`; `7-57/10`;
-- `6,16,…,56`; `11,26,41,56`; `7,22,37,52`; `*/30`. 59 is the only minute of
-- the 60 that survives all of them.
--
-- Cadence: hourly. Edition counts and set/player rollups change on the order of
-- days; the measured full refresh is 99 s cold / ~11 s warm, so hourly is cheap
-- and leaves the freshness question far from the 180 min watchlist ceiling.
--
-- Revert: SET LOCAL ROLE cron_heavy; SELECT cron.unschedule('rpc-series-detail-rollup');
DO $do$
BEGIN
  SET LOCAL ROLE cron_heavy;
  PERFORM cron.schedule(
    'rpc-series-detail-rollup',
    '59 * * * *',
    'SELECT public.refresh_series_detail_rollup(240);'
  );
  -- ⚠ RESET ROLE is required, not tidiness. SET LOCAL ROLE survives the DO
  -- block for the rest of the transaction, and the migration runner's own
  -- INSERT into supabase_migrations.schema_migrations then fails 42501 as
  -- cron_heavy — the whole migration rolls back with the schedule looking fine.
  -- Measured: the first apply of this file did exactly that.
  RESET ROLE;
END
$do$;
