-- pg_cron jobid 871 (rpc-capture-allday-best-offers, 20 13 * * * UTC = 5:20 AM PT) was scheduled outside a migration
-- (block 7 of the FMV engine pass named it as Trevor's one line); re-recorded by Cowork ~7:05 PM PT 11-12 so the
-- schedule has a history row and a file. cron.schedule upserts on (jobname, username): it must return 871, or the
-- transaction rolls back rather than create a duplicate. The lane logs `allday-best-offer-daily` and is already on
-- pipeline_cadence_watchlist.
DO $$
DECLARE v bigint;
BEGIN
  v := cron.schedule('rpc-capture-allday-best-offers', '20 13 * * *', $c$select public.capture_allday_best_offers()$c$);
  IF v <> 871 THEN
    RAISE EXCEPTION 'cron.schedule returned % (expected 871): would duplicate the job', v;
  END IF;
END $$;
