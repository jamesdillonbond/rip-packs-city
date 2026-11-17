-- audit_20260830_wmc_reindex_tonight_schedule_five_one_off_cron_heavy_slots
--
-- Second half of 20260830_wmc_four_indexes_are_2_to_4x_bloated_* (MAINTAIN granted, verify
-- function created; control-run at 03:4xZ returned the four densities 22.5/28.3/41.6/48.7 %
-- and logged the baseline pipeline_runs row). Schedules the four REINDEX INDEX CONCURRENTLY
-- slots + the verify slot as cron_heavy. The schedules are daily by cron syntax; the verify
-- slot's second statement unschedules all five (it runs as cron_heavy, their owner), so they
-- fire once. If the verify slot itself fails they RECUR DAILY until unscheduled:
--   SET ROLE cron_heavy; SELECT cron.unschedule(jobname) FROM cron.job WHERE jobname LIKE 'tmp-reindex-wmc-%';

DO $$
DECLARE v bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname LIKE 'tmp-reindex-wmc-%') THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: tmp-reindex-wmc-* jobs already exist';
  END IF;
  IF NOT has_table_privilege('cron_heavy', 'public.wallet_moments_cache', 'MAINTAIN') THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: cron_heavy lacks MAINTAIN on wallet_moments_cache';
  END IF;
  SET LOCAL ROLE cron_heavy;
  v := cron.schedule('tmp-reindex-wmc-1', '9 8 * * *',   'REINDEX INDEX CONCURRENTLY public.idx_wmc_cohort_cover');
  v := cron.schedule('tmp-reindex-wmc-2', '33 8 * * *',  'REINDEX INDEX CONCURRENTLY public.idx_wmc_coll_ek_serial_cover');
  v := cron.schedule('tmp-reindex-wmc-3', '9 10 * * *',  'REINDEX INDEX CONCURRENTLY public.idx_wmc_moment_collection_cover');
  v := cron.schedule('tmp-reindex-wmc-4', '33 10 * * *', 'REINDEX INDEX CONCURRENTLY public.wallet_moments_cache_wallet_collection_moment_key');
  v := cron.schedule('tmp-reindex-wmc-verify', '49 10 * * *',
       'SELECT public.run_wmc_reindex_verify(); SELECT cron.unschedule(jobname) FROM cron.job WHERE jobname LIKE ''tmp-reindex-wmc-%'' AND username = current_user;');
  RESET ROLE;
  IF (SELECT count(*) FROM cron.job WHERE jobname LIKE 'tmp-reindex-wmc-%' AND username = 'cron_heavy' AND active) <> 5 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: expected 5 active cron_heavy tmp-reindex-wmc-* jobs';
  END IF;
END $$;
