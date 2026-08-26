-- audit_20260825_repair_pg17_unreachable_fmv_recalc_window_index
--
-- RECORD-ONLY. The real work was three statements that CANNOT run inside a
-- transaction block, so they were executed as one-off pg_cron jobs (the recipe in
-- docs/reference/tooling-gotchas.md). This file exists so migration-parity has a
-- committed artefact and so the revert path is in the repo rather than in a
-- session transcript. Applying it a second time asserts and changes nothing.
--
-- ── WHAT WAS WRONG ─────────────────────────────────────────────────────────────
-- `idx_sales_2026_fmv_recalc_window` was built for `fmv_recalc_edition_page` and
-- had been scanned 3 times in 75 days while costing 99 MB. Cause (PG 17.6):
--
--     CREATE INDEX … WHERE (price_usd > 0 AND edition_id IS NOT NULL)
--
-- `sales_2026.edition_id` is declared NOT NULL, so PostgreSQL 17 constant-folds the
-- query's own `edition_id IS NOT NULL` qual away BEFORE predicate proving. The
-- index predicate then cannot be proven, and the index leaves the candidate set.
--
-- ⚠ PROVEN BOTH DIRECTIONS on a scratch table, not reasoned:
--   * predicate WITH the conjunct  → Seq Scan even under `enable_seqscan = off`
--   * predicate WITHOUT it         → Index Only Scan, chosen with seqscan enabled
--
-- ── WHY DROPPING THE CONJUNCT IS SAFE, AND WHAT KIND OF PROOF THAT IS ───────────
-- This is an EQUIVALENCE claim, which this repo requires be proven over the
-- population rather than by a plan comparison. Here the proof is stronger than a
-- row count: `edition_id` carries a NOT NULL constraint on the parent and on every
-- partition, so `edition_id IS NOT NULL` is true for every row that can exist. The
-- old and new predicates select the identical row set BY CONSTRAINT.
--
-- ── EXECUTED 2026-08-25 PT (2026-08-26 UTC), each as a one-off pg_cron job ──────
--   1. ALTER ROLE postgres SET statement_timeout = '600s';      -- reverted at 06:01Z
--      (a self-healing `ALTER ROLE postgres RESET statement_timeout` job was armed
--       BEFORE this, so a dead session could not leave the budget raised)
--   2. CREATE INDEX CONCURRENTLY idx_sales_2026_fmv_recalc_window_v2
--        ON public.sales_2026 USING btree (sold_at DESC)
--        INCLUDE (edition_id, collection_id)
--        WHERE (price_usd > (0)::numeric);
--      -> 05:34:01Z → 05:37:23Z, 202 s, indisvalid = true
--   3. DROP INDEX CONCURRENTLY public.idx_sales_2026_fmv_recalc_window;
--   4. ALTER INDEX  public.idx_sales_2026_fmv_recalc_window_v2
--        RENAME TO idx_sales_2026_fmv_recalc_window;   -- keeps the documented name
--   5. VACUUM (INDEX_CLEANUP OFF, ANALYZE) public.sales_2026;  -- see the caveat below
--
-- ── MEASURED, POST-SHIP, ON THE UNMODIFIED PRODUCTION QUERY ─────────────────────
-- Plan node for the 90-day window on sales_2026:
--   before  Parallel Index Scan using sales_2026_collection_id_sold_at_idx  cost 51,040.92
--   after   Parallel Index Only Scan using idx_sales_2026_fmv_recalc_window cost 15,264.74
-- EXPLAIN (ANALYZE, BUFFERS): 18,124 ms, 84,667 buffers (79,249 hit / 5,418 read).
-- Against the 50,471 ms recorded in docs/reference/database.md for the as-written
-- form, that is ~2.8x faster — reproducing the predicted 2.9x.
--
-- ⚠ THE BUFFER HALF OF THE PREDICTION DID NOT REPRODUCE, AND THE REASON IS NAMED.
-- The filing predicted ~48,494 buffers; measured 84,667. `Heap Fetches: 82,082` is
-- the whole gap: the Index Only Scan degrades to heap lookups wherever the
-- visibility map is not set. `relallvisible/relpages` was 31,355/37,671 (83.2%),
-- so step 5 above was run to recover it -> 33,388/37,671 (88.6%). The remaining
-- shortfall is expected to close as autovacuum catches up; DO NOT record the buffer
-- figure as final without re-measuring after a full autovacuum cycle.
--
-- ── REVERT ─────────────────────────────────────────────────────────────────────
-- One statement, as a one-off pg_cron job (it cannot run in a transaction):
--   CREATE INDEX CONCURRENTLY idx_sales_2026_fmv_recalc_window_old
--     ON public.sales_2026 USING btree (sold_at DESC)
--     INCLUDE (edition_id, collection_id)
--     WHERE (price_usd > (0)::numeric AND edition_id IS NOT NULL);
-- then drop and rename as above. ⚠ Reverting restores an index the planner cannot
-- use; there is no scenario in which the old predicate is preferable.
--
-- No function body changed, so no DB-invariant pin moved and no test needed
-- re-pointing (verified: no file under supabase/tests/ or __tests__/ names this
-- index).

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT indexdef INTO v_def
  FROM pg_indexes
  WHERE schemaname = 'public' AND indexname = 'idx_sales_2026_fmv_recalc_window';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'idx_sales_2026_fmv_recalc_window is absent — the repair did not survive';
  END IF;

  -- Assert the PROPERTY (the redundant conjunct is gone), not the exact spelling.
  IF v_def ILIKE '%edition_id IS NOT NULL%' THEN
    RAISE EXCEPTION 'idx_sales_2026_fmv_recalc_window still carries the redundant '
                    'edition_id IS NOT NULL conjunct — it is unreachable on PG17: %', v_def;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'idx_sales_2026_fmv_recalc_window' AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'idx_sales_2026_fmv_recalc_window exists but is NOT indisvalid — '
                    'this is the corpse of a killed CREATE INDEX CONCURRENTLY, drop it';
  END IF;
END $$;
