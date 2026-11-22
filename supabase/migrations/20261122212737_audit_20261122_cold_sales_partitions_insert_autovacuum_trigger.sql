-- 2026-11-22 ~1:27 PM PT (Claude Code cloud, autonomous daytime pass)
--
-- SYMPTOM: the top Vercel runtime-error group of the day — the set page's Recent Sales panel,
-- `get_set_activity` "canceling statement due to statement timeout" (8 s), 6 in 24 h on Top Shot
-- holo-icon ×2, the-champion-s-path-2024 ×2, the-champion-s-path, 2025-nba-playoffs-common. The
-- page degrades honestly (ok:false, three-state), so this is a cost defect, not an honesty one.
--
-- MECHANISM (measured, warm, EXPLAIN (ANALYZE, BUFFERS)): on the sparse-wide path the function
-- asks "does the collection have ≥ 5,000 sales in the last 365 days?" with an un-ordered
-- `SELECT 1 … LIMIT 5000`. The planner walks sales_2025 first. Its Index Only Scan did
-- **3,316 heap fetches / 3,764 blocks** for that answer because sales_2025 was only 76 %
-- all-visible (64,717 / 85,054 pages; last autovacuum 10-06; 103,495 inserts since vacuum).
-- The partition's reloptions carried a tuned DEAD-tuple trigger (0.05) but the default INSERT
-- trigger (0.2 × 2.38 M ≈ 476 k inserts), and its writes are BACKFILL INSERTS, which that
-- dead-tuple trigger never sees. 2020–2024 are the same shape (sales_2024: 79 %, 2021: 83 %).
-- The hot partition (sales_2026) is covered by job 383 + its own insert trigger and read 99 %.
--
-- ONE-OFF REPAIR (run out-of-band just before this file, execute_sql, Large instance):
--   VACUUM (ANALYZE) sales_2025 → 100 % all-visible (85,214 / 85,214), then sales_2024, sales_2023.
--   holo-icon get_set_activity(…, 20, 0): 16,693 → 14,014 buffers; the count pass now reads its
--   answer heap-free.
--
-- WHAT THIS MIGRATION DOES: makes the repair durable WITHOUT a new pg_cron lane (lane budget,
-- strategy-2026-11-22 §4): an insert-driven autovacuum trigger on the cold partitions, the same
-- reloption sales_2027 already carries (0.01). Autovacuum is not subject to statement_timeout.
-- sales_2025 then revisits every ~25 k inserts instead of ~476 k. Per-table catalog update only.
--
-- ⚠ sales_2028 must get these reloptions when it is created (the 08-31 file's note).
-- EXIT: pg_stat_user_tables.last_autovacuum advances on sales_2025 after the next backfill wave, and
--   relallvisible/relpages stays > 95 % on 2023–2025 a week out (read ~11-29).
-- FALSIFIER: < 90 % a week out WITH autovacuum_count climbing ⇒ UPDATE churn under long snapshots,
--   not insert rot — measure, do not lower further.
-- REVERT: ALTER TABLE public.sales_20NN RESET (autovacuum_vacuum_insert_scale_factor); for NN in 20..25.

ALTER TABLE public.sales_2020 SET (autovacuum_vacuum_insert_scale_factor = 0.01);
ALTER TABLE public.sales_2021 SET (autovacuum_vacuum_insert_scale_factor = 0.01);
ALTER TABLE public.sales_2022 SET (autovacuum_vacuum_insert_scale_factor = 0.01);
ALTER TABLE public.sales_2023 SET (autovacuum_vacuum_insert_scale_factor = 0.01);
ALTER TABLE public.sales_2024 SET (autovacuum_vacuum_insert_scale_factor = 0.01);
ALTER TABLE public.sales_2025 SET (autovacuum_vacuum_insert_scale_factor = 0.01);

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname IN ('sales_2020','sales_2021','sales_2022','sales_2023','sales_2024','sales_2025')
     AND 'autovacuum_vacuum_insert_scale_factor=0.01' = ANY (c.reloptions)
     AND EXISTS (SELECT 1 FROM unnest(c.reloptions) o WHERE o LIKE 'autovacuum_vacuum_scale_factor=%');
  IF v_n <> 6 THEN RAISE EXCEPTION 'expected 6 cold partitions with the insert trigger AND their existing dead-tuple trigger, got %', v_n; END IF;
END $$;
