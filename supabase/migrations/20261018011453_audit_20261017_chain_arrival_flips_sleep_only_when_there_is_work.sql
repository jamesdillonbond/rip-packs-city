-- audit_20261017_chain_arrival_flips_sleep_only_when_there_is_work
--
-- 2026-10-17, applied 6:14 PM PT via apply_migration (recorded version 20261018011453; Cowork cloud; Trevor: "Keep going").
--
-- check_zero_yield_lanes() newly lists `chain-arrival-flips` (last find 10-10, 5,045 runs in 7 days,
-- 30-day baseline 16,565). Re-derived live: it is a DRAINED BACKLOG, not a stall.
--   * every run ok=true since 10-11; 0 collected / 0 enqueued / 0 dispatched each day 10-11 -> 10-17;
--   * chain_arrival_flip_reads: 15,123 rows, 0 pending (found 12,981, not_the_sold_seed_margin 1,593,
--     not_sold_by_wallet 521, no_delivery_before_sale 28); last row created 10-10 4:01 PM PT;
--   * positive control: 0 done probes with no sender and 'no TopShot.Withdraw ...' lack a flip read, so
--     the lane's enqueue step has nothing to take; the ~800 probes the daily seed added since 10-10
--     produced no new candidate. It resumes by itself the moment the seed produces one.
--
-- But its job (681, `1-59/2 * * * *`) is `SELECT run_chain_arrival_flip_lane() FROM pg_sleep(27)`, so
-- every idle tick still holds a pg_cron connection for 27 s: 720 a day (cron.job_run_details, 24 h:
-- avg 27.15 s, max 28.87 s, 0 failures), ~5.4 h of slot time a day to log "nothing".
--
-- WHAT. The same "sleep only when there is work" guard as 20261002155614 / 20261009195532: the job runs
-- (and sleeps) only when a read is pending, a candidate is waiting, or on the :01/:11/:21/:31/:41/:51
-- ticks. The 10-minute tick keeps a `chain-arrival-flips` pipeline_runs row inside the watchlist's
-- max_silent_minutes = 20 (pipeline_cadence_watchlist, armed 10-10 for #79) and runs the enqueue step
-- on schedule. Measured guard: EXPLAIN ANALYZE shows a One-Time Filter ahead of the pg_sleep (never
-- executed when false), 55.8 ms, 14,421 shared hits, 0 reads. The function body is unchanged.
-- Effect: idle runs 720 -> 144 a day; throughput on a new backlog unchanged (any pending read or
-- waiting candidate makes every tick run).
--
-- Not suppressed in pipeline_zero_yield_suppressions on purpose (the 10-17 overnight reasoning for the
-- Pinnacle lanes): a zero-write-while-ok lane is exactly what that detector exists to catch. Re-open if
-- `enqueued` > 0 while `found` stays 0, or a tick turns ok=false.
--
-- REVERT:
--   SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rpc-chain-arrival-flips'),
--          command := 'SELECT public.run_chain_arrival_flip_lane() FROM pg_sleep(27);');

DO $$
DECLARE v_n int; v_cmd text;
BEGIN
  SELECT count(*), max(command) INTO v_n, v_cmd FROM cron.job WHERE jobname = 'rpc-chain-arrival-flips';
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected 1 rpc-chain-arrival-flips job, found %', v_n; END IF;
  IF v_cmd <> 'SELECT public.run_chain_arrival_flip_lane() FROM pg_sleep(27);' THEN
    RAISE EXCEPTION 'rpc-chain-arrival-flips command changed since 2026-10-17 6:15 PM PT: %', v_cmd;
  END IF;

  PERFORM cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rpc-chain-arrival-flips'),
    command := 'SELECT public.run_chain_arrival_flip_lane() FROM pg_sleep(27) WHERE extract(minute FROM now())::int % 10 = 1 OR EXISTS (SELECT 1 FROM public.chain_arrival_flip_reads f WHERE f.status = ''pending'') OR EXISTS (SELECT 1 FROM public.chain_arrival_probes p WHERE p.status = ''done'' AND p.from_address IS NULL AND p.last_error LIKE ''no TopShot.Withdraw%'' AND NOT EXISTS (SELECT 1 FROM public.chain_arrival_flip_reads f WHERE f.wallet = p.wallet AND f.nft_id = p.nft_id));');
END $$;
