-- 2026-10-02 (PT) — `rpc-backfill-pack-supply` (jobid 15) asks for 8 dists per
-- run, not 400, so the run finishes inside the ~150 s edge gateway cap and
-- writes its pipeline_runs row again.
--
-- SYMPTOM. Sentinel "Edge Lane Observability" WARN 10-02 8:04 PM PT:
-- `rpc-backfill-pack-supply (pipeline_runs:topshot-pack-supply-backfill ?h > ?h)`
-- — the claimed pipeline_runs coverage had written NO row in ~73 h. Measured:
-- pipeline_runs_daily's last day for the lane is 09-25; pg_cron dispatched it
-- "succeeded" every day 09-26..10-02 (dispatch, not outcome); the 10-02 08:15Z
-- call shows in function_edge_logs as a 504 at 08:17:30Z — the gateway kill.
--
-- CAUSE. The candidate set (`get_topshot_supply_backfill_targets`: TS dists with
-- a metadata uuid that have never succeeded) was 2 dists through 09-25 and is
-- 498 now (358 never attempted) after dists gained a uuid on 09-25/26. The
-- function attempts every target in ONE synchronous request at conc 2, and each
-- attempt against the dead upstream (#81, `HTTP 530`) costs ~18 s of retries.
-- 10 rounds fit in 150 s — exactly the 20 `HTTP 530` failure stamps per day in
-- topshot_pack_supply since 09-26 — then the worker is killed before
-- logPipelineRun runs, so the lane went invisible while still failing.
--
-- WHAT. limit=400 -> limit=8: 4 rounds x ~18 s ~= 75 s, half the budget, so the
-- terminal row (ok=false, HTTP 530 while #81 stands) lands every run. This does
-- NOT fix #81 (the upstream is gone; the source decision is open) and it slows
-- nothing that works today: 0 of the 498 succeed. If the host ever answers,
-- raise the limit back on measured per-dist latency, not before.
--
-- The key in the command is untouched: the replace edits only `limit=400`,
-- and the guard below asserts exactly one occurrence first (no key in this file).
--
-- Revert: SELECT cron.alter_job(15, command => replace((SELECT command FROM cron.job WHERE jobid = 15), 'limit=8&', 'limit=400&'));

DO $$
DECLARE
  v_cmd text;
  v_n   int;
BEGIN
  SELECT command INTO v_cmd FROM cron.job WHERE jobid = 15 AND jobname = 'rpc-backfill-pack-supply';
  IF v_cmd IS NULL THEN
    RAISE EXCEPTION 'rpc-backfill-pack-supply (jobid 15) not found';
  END IF;
  IF v_cmd LIKE '%mode=supply&limit=8&%' THEN
    RETURN;  -- already applied
  END IF;
  v_n := (length(v_cmd) - length(replace(v_cmd, 'mode=supply&limit=400&', ''))) / length('mode=supply&limit=400&');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected exactly one mode=supply&limit=400& in jobid 15, found %', v_n;
  END IF;
  PERFORM cron.alter_job(15, command => replace(v_cmd, 'mode=supply&limit=400&', 'mode=supply&limit=8&'));
END $$;
