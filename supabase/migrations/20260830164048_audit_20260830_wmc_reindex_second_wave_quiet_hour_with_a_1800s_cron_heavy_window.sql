-- audit_20260830_wmc_reindex_second_wave_quiet_hour_with_a_1800s_cron_heavy_window
--
-- WHY: the 08-30 08Z wave (20260830030951, jobids 397-401) rebuilt only idx_wmc_cohort_cover (614 MB @ 22.5 % ->
-- 166 MB @ 81 %); 398 (idx_wmc_coll_ek_serial_cover) died at cron_heavy's 600 s statement_timeout, 399/400 were
-- unscheduled unrun, and the 10:49Z verify (401) wrote wmc-reindex-verify ok=false with the three targets still at
-- 28 / 42 / 49 % leaf density. Two things were wrong with that wave, both fixed here:
--   1. the slot: 08:09-08:43Z coincided with the day's worst pool-exhaustion window (six concurrent walks of one
--      wallet, edition pages at 45 s, jobid 326 job-startup timeout). Measured over the last 3 days,
--      cron.job_run_details puts 02Z and 03Z at 519-596 cron-seconds/hour, the two quietest hours (next: 01Z 1,078,
--      04Z 1,119; the 08Z hour is >3x). This wave runs 02:03-03:53Z.
--   2. the budget: REINDEX CONCURRENTLY is dominated by its wait phases on concurrent transactions, not the heap
--      scan (memory: pgcron-oneoff-runs-concurrently-ddl), and the wmc table is upserted continuously. A 600 s
--      cap is what killed 398 after the swap. A one-off statement cannot raise its own timeout (SET + REINDEX in
--      one command = implicit transaction block = CONCURRENTLY refused), so the ROLE budget is raised to 1800 s
--      for the window by a postgres-owned job, and RESTORED to 600 s (never RESET -- that would drop cron_heavy
--      to the cluster 120 s) by another, scheduled in the same migration so it self-heals if nothing else runs.
--      Collateral, accepted: every cron_heavy job that starts between 02:00 and 04:03Z gets the 1800 s budget
--      (303 every 10 min, 71 at :13, 356 at :41, 215 at 03:37, 331 at 03:55) -- all of them finished under 260 s
--      today, and none has a runaway history.
--
-- WHAT: six one-off slots. Daily by cron syntax; each owner's last slot unschedules that owner's tmp jobs, so they
-- fire once. If a closing slot fails they RECUR DAILY until unscheduled by hand:
--   SELECT cron.unschedule(jobname) FROM cron.job WHERE jobname LIKE 'tmp-reindex-wmc-%';            -- as postgres
--   DO $$ BEGIN SET LOCAL ROLE cron_heavy; PERFORM cron.unschedule(jobname) FROM cron.job WHERE jobname LIKE 'tmp-reindex-wmc-%'; END $$;
--   ALTER ROLE cron_heavy SET statement_timeout = '600s';
-- VERIFY next pass: pipeline_runs wmc-reindex-verify at ~04:06Z ok=true with all four targets >= 60 %; zero
-- indisvalid=false on wallet_moments_cache; pg_roles.rolconfig for cron_heavy = statement_timeout=600s; zero
-- tmp-reindex-wmc-% rows in cron.job. A *_ccnew index left INVALID = a build that hit even 1800 s: DROP INDEX
-- CONCURRENTLY it (one-off cron_heavy job) and file the duration.

DO $$
DECLARE v bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname LIKE 'tmp-reindex-wmc-%') THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: tmp-reindex-wmc-* jobs already exist';
  END IF;
  IF NOT has_table_privilege('cron_heavy', 'public.wallet_moments_cache', 'MAINTAIN') THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: cron_heavy lacks MAINTAIN on wallet_moments_cache';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
             WHERE i.indrelid = 'public.wallet_moments_cache'::regclass AND NOT i.indisvalid) THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: an INVALID index already exists on wallet_moments_cache';
  END IF;
  IF (SELECT array_to_string(rolconfig, ';') FROM pg_roles WHERE rolname = 'cron_heavy') <> 'statement_timeout=600s' THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: cron_heavy rolconfig is not exactly statement_timeout=600s';
  END IF;

  -- postgres-owned: open and close the budget window (ALTER ROLE needs the role's owner/superuser path).
  v := cron.schedule('tmp-reindex-wmc-budget-open',  '0 2 * * *', $c$ALTER ROLE cron_heavy SET statement_timeout = '1800s'$c$);
  v := cron.schedule('tmp-reindex-wmc-budget-close', '3 4 * * *',
       $c$ALTER ROLE cron_heavy SET statement_timeout = '600s'; SELECT cron.unschedule(jobname) FROM cron.job WHERE jobname LIKE 'tmp-reindex-wmc-budget-%' AND username = current_user;$c$);

  SET LOCAL ROLE cron_heavy;
  v := cron.schedule('tmp-reindex-wmc-2', '3 2 * * *',  'REINDEX INDEX CONCURRENTLY public.idx_wmc_coll_ek_serial_cover');
  v := cron.schedule('tmp-reindex-wmc-3', '43 2 * * *', 'REINDEX INDEX CONCURRENTLY public.idx_wmc_moment_collection_cover');
  v := cron.schedule('tmp-reindex-wmc-4', '23 3 * * *', 'REINDEX INDEX CONCURRENTLY public.wallet_moments_cache_wallet_collection_moment_key');
  v := cron.schedule('tmp-reindex-wmc-verify', '6 4 * * *',
       'SELECT public.run_wmc_reindex_verify(); SELECT cron.unschedule(jobname) FROM cron.job WHERE jobname LIKE ''tmp-reindex-wmc-%'' AND username = current_user;');
  RESET ROLE;

  IF (SELECT count(*) FROM cron.job WHERE jobname LIKE 'tmp-reindex-wmc-%' AND username = 'cron_heavy' AND active) <> 4 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: expected 4 active cron_heavy tmp-reindex-wmc-* jobs';
  END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname LIKE 'tmp-reindex-wmc-budget-%' AND username = 'postgres' AND active) <> 2 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: expected 2 active postgres tmp-reindex-wmc-budget-* jobs';
  END IF;
END $$;
