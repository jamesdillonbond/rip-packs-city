-- 2026-10-02 (PT) — `VACUUM FULL net._http_response` (jobid 542) runs DAILY at 2:16 AM PT,
-- not weekly. The 09-20 exit condition ("store stays < 1 GB") is falsified: the sentinel's
-- `pg_net Dispatch` arm warned 10-02 8:04 PM PT at 12.4 GB, five days after the 09-27 run.
--
-- MEASURED 10-02 ~8:20 PM PT:
--   * pg_total_relation_size 12 GB; live `content` 432 MB in 9,070 rows (TTL 6 h).
--   * New response content ~55-80 MB/h (hourly sums over the TTL window) ~= 1.5-2 GB/day.
--     20260920095221 sized the job on ~380 MB/day, a 16-hour sample right after the reclaim.
--   * pg_toast_51873 (the TOAST, where all the space is): `n_dead_tup` 0, `autovacuum_count` 3,
--     `last_autovacuum` 2026-09-20 — no autovacuum in 12 days, its stats pinned at zero again
--     (#75's original defect, one level down). So dead TOAST is never made reusable and every
--     new response extends the file: 09-27 09:16Z ~0.5 GB -> 12 GB on 10-02 = ~2 GB/day.
--   * The weekly run itself is CHEAP: 09-27 took 14 s. VACUUM FULL copies only LIVE rows (a 17 MB
--     heap + their ~430 MB of TOAST), so its cost tracks the live set, not the dead bloat.
--
-- WHY DAILY FULL, NOT A PLAIN VACUUM: a plain VACUUM must scan the whole TOAST file to mark
-- dead space reusable (12 GB today, ~2 GB at a daily cadence) and returns nothing to the OS;
-- the FULL reads only the live ~0.45 GB and leaves the file at its live size. ~15 s of
-- ACCESS EXCLUSIVE a day on the response store: pg_net's worker and the collect lanes wait it
-- out (their budgets are 60-120 s). Peak store ~2.5 GB, well under the sentinel's 8 GB warn.
-- Slot unchanged (:16, the coverage trough per 20260920095221; 20 min before the 09:36Z
-- reconcile).
--
-- FALSIFIER: a run > 60 s, or the store > 4 GB at the next sentinel, means the live set or the
-- write rate moved — measure both before touching the cadence.
-- REVERT: SELECT cron.schedule('rpc-weekly-vacuum-full-pgnet-response', '16 9 * * 0', 'VACUUM FULL net._http_response');

SELECT cron.schedule('rpc-weekly-vacuum-full-pgnet-response', '16 9 * * *', 'VACUUM FULL net._http_response');

DO $$
DECLARE v_id int; v_sched text; v_user text;
BEGIN
  SELECT jobid, schedule, username INTO v_id, v_sched, v_user
    FROM cron.job WHERE jobname = 'rpc-weekly-vacuum-full-pgnet-response';
  IF v_id IS DISTINCT FROM 542 THEN RAISE EXCEPTION 'jobid changed: %', v_id; END IF;
  IF v_sched <> '16 9 * * *' THEN RAISE EXCEPTION 'schedule not applied: %', v_sched; END IF;
  IF v_user <> 'postgres' THEN RAISE EXCEPTION 'owner changed: %', v_user; END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'rpc-weekly-vacuum-full-pgnet-response') <> 1 THEN
    RAISE EXCEPTION 'duplicate job created';
  END IF;
END $$;
