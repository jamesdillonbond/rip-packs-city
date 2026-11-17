-- Applied first via the dashboard SQL editor (FMV comparables session, ~8:15 AM PT 11-12) as pg_cron jobid 868,
-- with no history row; re-recorded by Cowork (~8:35 AM PT). cron.schedule upserts on (jobname, username), so this
-- must return 868 — anything else means a duplicate was created and the transaction is rolled back.
DO $$
DECLARE v bigint;
BEGIN
  v := cron.schedule('rpc-refresh-fmv-comparable-estimates', '36 1,7,13,19 * * *', $c$select public.refresh_fmv_comparable_estimates()$c$);
  IF v <> 868 THEN
    RAISE EXCEPTION 'cron.schedule returned % (expected 868): would duplicate the job', v;
  END IF;
END $$;