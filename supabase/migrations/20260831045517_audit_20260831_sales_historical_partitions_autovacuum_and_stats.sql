-- audit_20260831_sales_historical_partitions_autovacuum_and_stats
--
-- WHY (measured 2026-08-31, in response to the sentinel alert "fmv-backfill · failure_rate 5/9 runs failed,
-- fmv_backfill_candidates: canceling statement due to statement timeout"):
-- `fmv_backfill_candidates()` carries `SET statement_timeout = '60s'` and was tipping over it (failures at 60.2/60.6/
-- 71.8 s; the runs that DID succeed still cost 20-68 s and every one returned `stage: caught_up`, 0 rows).
--
-- The cause was NOT the function's SQL. It was the statistics and visibility maps of the `sales` partitions:
--   * `sales_2023` had NEVER been vacuumed OR analyzed (last_vacuum, last_autovacuum, last_analyze all NULL) despite
--     89,369 updates, and `pg_stat_user_tables.n_live_tup` read **0** for sales_2021/2022/2023. With no stats the
--     planner estimated `rows=1` out of a 2.85M-row anti-join and chose a plan whose hash spills to disk.
--   * Stale visibility maps turned the "Index Only Scans" into random heap I/O: **590,412 heap fetches** across the
--     partitions in one run (sales_2023 265,287; sales_2024 206,237; sales_2025 49,041; sales_2026 47,642;
--     sales_2020 21,557). sales_2022, already frozen, did 0 — the control that proves the mechanism.
--
-- A one-off `VACUUM (ANALYZE)` of sales_2020..sales_2026 (run out-of-band 2026-08-31 ~04:3xZ — VACUUM cannot run
-- inside a migration's transaction) took heap fetches to **0** and the unmodified production query from
-- 20-70 s to **8.3 s**, restoring ~7x headroom under the 60 s cap.
--
-- ⛔ THE FUNCTION BODY IS DELIBERATELY UNCHANGED. A rewrite (DISTINCT-first, nested-loop anti join) was written and
-- measured against the same warm cache: **9.0 s vs the original's 8.3 s** — i.e. NO improvement. An earlier 4.2 s
-- reading for that rewrite was a warm-cache artifact taken before the vacuum, and acting on it would have shipped
-- churn in a hot path for a gain that does not exist. Both shapes must scan the same 2.43M index entries; the
-- 18,901 distinct editions cannot be reached more cheaply without a loose index scan or a maintained coverage table,
-- neither of which is justified at 8 s with the queue permanently caught up.
--
-- WHAT THIS MIGRATION DOES: makes the repair durable. sales_2025/2026/2027 ALREADY carry tuned autovacuum reloptions
-- from earlier work; sales_2020..sales_2024 were left on defaults, which is precisely why they were never visited --
-- the default `autovacuum_vacuum_scale_factor = 0.2` needs ~250k dead tuples on a 1.25M-row partition and
-- sales_2023 had only accumulated 89k. These five historical partitions are set to the SAME values the 2025/2026
-- partitions already use, so the whole table follows one convention.
--
-- ⚠ NEW PARTITIONS INHERIT NOTHING: storage parameters on the partitioned parent do not propagate. Whoever creates
-- sales_2028 must set these reloptions on it too, or it will silently rejoin the default class.
--
-- Falsifier: `pg_stat_user_tables.last_autovacuum` for sales_2020..sales_2024 should stop being NULL, and
-- `Heap Fetches` in the fmv_backfill_candidates plan should stay near 0. If fmv-backfill timeouts return with heap
-- fetches still at 0, the cause is something else -- re-measure, do not raise the 60 s timeout to hide it.
--
-- REVERT: ALTER TABLE public.sales_20NN RESET (autovacuum_vacuum_scale_factor, autovacuum_analyze_scale_factor);
--         for each of 2020..2024.

ALTER TABLE public.sales_2020 SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.sales_2021 SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.sales_2022 SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.sales_2023 SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.sales_2024 SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);

DO $mig$
DECLARE
  v_missing text[];
BEGIN
  SELECT coalesce(array_agg(c.relname ORDER BY c.relname), '{}')
    INTO v_missing
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('sales_2020','sales_2021','sales_2022','sales_2023','sales_2024')
    AND (c.reloptions IS NULL
         OR NOT (c.reloptions @> ARRAY['autovacuum_vacuum_scale_factor=0.05']
             AND c.reloptions @> ARRAY['autovacuum_analyze_scale_factor=0.02']));
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: reloptions not set on %', v_missing;
  END IF;
END
$mig$;
