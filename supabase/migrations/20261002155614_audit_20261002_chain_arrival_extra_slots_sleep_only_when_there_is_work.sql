-- 2026-10-02 (PT) — the four extra chain-arrival slots (:08 / :23 / :38 / :53)
-- sleep only when there is work; idle, they return in ~30 ms instead of
-- holding a pg_cron worker for 8–53 s of every minute.
--
-- WHY. 20260930221000 added four staggered copies of `rpc-chain-arrival-lane`
-- (`SELECT public.run_chain_arrival_lane() FROM pg_sleep(n)`) to drain a
-- 37,190-probe bisection backlog (~6 days at one 24-call burst a minute). It
-- drained in under two days: measured 10-02 ~9:05 AM PT, chain_arrival_probes
-- is 132,478 rows, ALL `done`; chain_arrival_requests is empty; the lane's
-- last pipeline_runs row dispatched 0 / walked 0; the daily seed (4:13 AM PT)
-- added 11 probes today. The five slots ran 7,200 times in 24 h, every run
-- ~0.1 s of work — and the four extras held a worker in pg_sleep for
-- 8 + 23 + 38 + 53 = 122 s of every minute, i.e. two of cron.max_running_jobs
-- (32) permanently, for nothing. No `job startup timeout` in 7 days, so this
-- is headroom, not an incident.
--
-- WHAT. Keep the slots (the next large seed drains at the 09-30 pace), but
-- gate the sleep on pending work. `SELECT … FROM pg_sleep(n) WHERE EXISTS (…)`
-- with an UNCORRELATED subquery plans as Result → One-Time Filter (InitPlan)
-- → Function Scan: when the filter is false the Function Scan is NEVER
-- EXECUTED, so pg_sleep is not called. Proven live before the apply:
-- EXPLAIN ANALYZE of `SELECT 1 FROM pg_sleep(3) WHERE EXISTS (SELECT 1 FROM
-- chain_arrival_probes WHERE status <> 'done')` reads "Function Scan on
-- pg_sleep (never executed)", execution 30.8 ms (the probe scan). The gate is
-- the lane's own definition of work: a probe not terminal (the lane picks
-- `status IN ('floor','bisect','window','walk')`; 'done' and 'failed' are
-- terminal per the CHECK) or a request in flight to collect / expire. With
-- work present the command is byte-for-byte the 09-30 behaviour.
--
-- The :00 base job `rpc-chain-arrival-lane` is NOT gated: it stays the
-- once-a-minute heartbeat that writes the `chain-arrivals` pipeline_runs row
-- the instruments read.
--
-- Revert: SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rpc-chain-arrival-lane-08'), command => 'SELECT public.run_chain_arrival_lane() FROM pg_sleep(8);');
--   … and the same for -23 / -38 / -53 with pg_sleep(23) / (38) / (53).

DO $$
DECLARE
  s record;
  v_cmd text;
  v_n int;
BEGIN
  FOR s IN SELECT * FROM (VALUES ('rpc-chain-arrival-lane-08', 8), ('rpc-chain-arrival-lane-23', 23),
                                 ('rpc-chain-arrival-lane-38', 38), ('rpc-chain-arrival-lane-53', 53)) v(jobname, secs)
  LOOP
    v_cmd := format(
      'SELECT public.run_chain_arrival_lane() FROM pg_sleep(%s) WHERE EXISTS (SELECT 1 FROM public.chain_arrival_probes WHERE status NOT IN (''done'', ''failed'')) OR EXISTS (SELECT 1 FROM public.chain_arrival_requests);',
      s.secs);
    SELECT count(*) INTO v_n FROM cron.job WHERE jobname = s.jobname;
    IF v_n <> 1 THEN RAISE EXCEPTION 'expected exactly one cron job named %, found %', s.jobname, v_n; END IF;
    PERFORM cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = s.jobname), command => v_cmd);
  END LOOP;
END $$;

-- Post-condition: all four carry the gate and their original offset.
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM cron.job
   WHERE jobname IN ('rpc-chain-arrival-lane-08','rpc-chain-arrival-lane-23','rpc-chain-arrival-lane-38','rpc-chain-arrival-lane-53')
     AND command LIKE 'SELECT public.run_chain_arrival_lane() FROM pg_sleep(%) WHERE EXISTS (SELECT 1 FROM public.chain_arrival_probes WHERE status NOT IN (''done'', ''failed'')) OR EXISTS (SELECT 1 FROM public.chain_arrival_requests);'
     AND active;
  IF v_n <> 4 THEN RAISE EXCEPTION 'chain-arrival gated slots: expected 4 gated active jobs, found %', v_n; END IF;
  IF (SELECT command FROM cron.job WHERE jobname = 'rpc-chain-arrival-lane') <> 'SELECT public.run_chain_arrival_lane();' THEN
    RAISE EXCEPTION 'the :00 base lane must stay ungated';
  END IF;
END $$;
