-- audit_20260809: RECORD-ONLY migration for six serial-1 partial indexes that were built
-- CONCURRENTLY and are ALREADY LIVE. This file exists for repo<->prod parity and to carry the
-- revert path; it does not (and cannot) build them, because CREATE INDEX CONCURRENTLY may not
-- run inside a transaction block and apply_migration wraps one.
--
-- Drains inbox docs/overnight/inbox/2026-08-09T1941Z.md "Fix 1", which had been parked as
-- operator-only on the belief that CONCURRENTLY cannot be driven from Cowork. It can: a
-- ONE-OFF pg_cron job runs its command over a fresh libpq connection outside any transaction
-- block, so CIC works there. That is the same server-side-execution trick already recorded for
-- long EXPLAINs. Budget note: pg_cron inherits the GLOBAL statement_timeout (120s) for jobs
-- running as `postgres`, which is NOT enough for the CIC wait phase -- see the sibling
-- migration audit_20260809_cron_statement_timeout_prefix_for_inert_proconfig_jobs.
--
-- The statements that were executed, one per one-off job (mirrors idx_sales_2026_serial1):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_<Y>_serial1
--     ON public.sales_<Y> USING btree (collection, edition_id, sold_at DESC)
--     WHERE (serial_number = 1);   -- for Y in 2020..2025
--
-- Measured build times (all indisvalid=true afterwards):
--   2020 110.6s · 2021 110.6s · 2022 50.3s · 2023 194.3s · 2024 2.7s · 2025 480.4s
--   (2024's first attempt died as `job startup timeout` -- pg_cron never started it because
--    2025's build was squatting a worker slot; it left NO partial index and succeeded on retry.)
-- Index sizes: 16/32/40/88/112/112 kB -- 400 kB total for 4,971 serial-1 rows.
--
-- Effect, planner-only EXPLAIN on public.topshot_2025_rookie_index (the /insights/rookies board):
--   total plan cost      79,591.62 -> 8,857.85   (-88.9%)
--   mint-#1 trophy node  76,275.06 -> 5,541.35   (-92.7%)
--   per-edition Append      778.22 ->    56.44
--   per partition: 2020 52.63->1.43 · 2021 58.18->1.68 · 2022 248.23->1.74
--                  2023 205.06->9.94 · 2024 103.97->12.75 · 2025 94.40->13.17
--
-- REVERT (each is independent; run from the SQL editor or a one-off pg_cron job, NOT here):
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_sales_2020_serial1;   -- and 2021..2025
DO $mig$
DECLARE
  y int;
  v_valid boolean;
BEGIN
  FOREACH y IN ARRAY ARRAY[2020,2021,2022,2023,2024,2025] LOOP
    SELECT i.indisvalid INTO v_valid
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = format('idx_sales_%s_serial1', y);

    IF v_valid IS NULL THEN
      RAISE EXCEPTION 'idx_sales_%_serial1 is ABSENT -- this record migration asserts it is already live', y;
    END IF;
    IF NOT v_valid THEN
      RAISE EXCEPTION 'idx_sales_%_serial1 exists but is INVALID -- drop it and rebuild CONCURRENTLY', y;
    END IF;
  END LOOP;
END
$mig$;