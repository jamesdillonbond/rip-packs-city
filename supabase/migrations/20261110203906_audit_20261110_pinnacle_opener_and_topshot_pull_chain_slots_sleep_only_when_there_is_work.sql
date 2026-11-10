-- audit_20261110_pinnacle_opener_and_topshot_pull_chain_slots_sleep_only_when_there_is_work
--
-- Claude Code cloud, 2026-11-10 ~12:39 PM PT. The 2026-10-02 idle-gate rule (cron-and-schedulers.md, "A staggered
-- pg_cron slot sleeps only when there is work"; precedent 20261002155614) applied to the two staggered slots that
-- never got it. Cron command only — the function bodies (pinned) are unchanged.
--
-- WHY: the cost-triage recipe (pg_cron worker-seconds per job, 24 h) put these two at the top of the whole estate:
--   rpc-pinnacle-opener-lane     1,439 runs, 64,895 s (45.1 s avg) — 45 s of that is pg_sleep(45); its pipeline
--                                 'pinnacle-pack-openers' wrote 0 rows in 1,440 runs.
--   rpc-topshot-pull-chain-lane  1,439 runs, 45,571 s (31.7 s avg) — pg_sleep(30); 'pack-pulls-chain-history'
--                                 idle in 1,402 of 1,440 runs.
-- Each held one of cron.max_running_jobs (32) asleep ~75 % of the time around the clock; 1 'job startup timeout'
-- (worker-slot exhaustion) in the same 24 h.
--
-- GATES (each keeps the function's own periodic step, so no work is lost; only idle latency changes):
--   opener:     minute % 10 = 0 (the function's 10-minute enqueue) OR a window is pending / in_flight.
--               An open with no opener is now enqueued within <= 10 min instead of <= 1 min when the lane is idle.
--   pull chain: minute % 15 = 0 (its 15-minute enqueue) OR minute = 7 (its hourly full naming pass) OR a request
--               is pending / in_flight. Collected reads are named in the same tick that collects them; a later
--               retry is covered by the :07 pass (topshot_chain_moment_reads.read_at has no index, so it is not
--               probed by the gate). Both status columns are indexed (idx_*_status).
-- Cadence watchlist: both pipelines allow 60 min of silence; gated they still log every 10 / 15 min.
--
-- REVERT:
--   SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rpc-pinnacle-opener-lane'),
--     command => 'SELECT public.run_pinnacle_opener_lane() FROM pg_sleep(45);');
--   SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rpc-topshot-pull-chain-lane'),
--     command => 'SELECT public.run_topshot_pull_chain_lane() FROM pg_sleep(30);');

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'rpc-pinnacle-opener-lane'
     AND command = 'SELECT public.run_pinnacle_opener_lane() FROM pg_sleep(45);';
  IF v_n <> 1 THEN RAISE EXCEPTION 'rpc-pinnacle-opener-lane: expected the ungated command, found % matching job(s)', v_n; END IF;
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'rpc-topshot-pull-chain-lane'
     AND command = 'SELECT public.run_topshot_pull_chain_lane() FROM pg_sleep(30);';
  IF v_n <> 1 THEN RAISE EXCEPTION 'rpc-topshot-pull-chain-lane: expected the ungated command, found % matching job(s)', v_n; END IF;

  PERFORM cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rpc-pinnacle-opener-lane'), command =>
    'SELECT public.run_pinnacle_opener_lane() FROM pg_sleep(45) WHERE extract(minute FROM now())::int % 10 = 0 OR EXISTS (SELECT 1 FROM public.pinnacle_opener_windows WHERE status IN (''pending'', ''in_flight''));');
  PERFORM cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rpc-topshot-pull-chain-lane'), command =>
    'SELECT public.run_topshot_pull_chain_lane() FROM pg_sleep(30) WHERE extract(minute FROM now())::int % 15 = 0 OR extract(minute FROM now())::int = 7 OR EXISTS (SELECT 1 FROM public.topshot_pull_chain_requests WHERE status IN (''pending'', ''in_flight''));');
END $$;

DO $$
BEGIN
  IF (SELECT command FROM cron.job WHERE jobname = 'rpc-pinnacle-opener-lane' AND active) NOT LIKE '%pg_sleep(45) WHERE extract(minute FROM now())::int % 10 = 0 OR EXISTS (SELECT 1 FROM public.pinnacle_opener_windows WHERE status IN (''pending'', ''in_flight''));' THEN
    RAISE EXCEPTION 'rpc-pinnacle-opener-lane gate not in place';
  END IF;
  IF (SELECT command FROM cron.job WHERE jobname = 'rpc-topshot-pull-chain-lane' AND active) NOT LIKE '%pg_sleep(30) WHERE extract(minute FROM now())::int % 15 = 0 OR extract(minute FROM now())::int = 7 OR EXISTS (SELECT 1 FROM public.topshot_pull_chain_requests WHERE status IN (''pending'', ''in_flight''));' THEN
    RAISE EXCEPTION 'rpc-topshot-pull-chain-lane gate not in place';
  END IF;
END $$;
