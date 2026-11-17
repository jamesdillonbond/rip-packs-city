-- tmp_pg17_probe_control_index
--
-- RECORD-ONLY, one of a set of three. The scratch probe these three migrations
-- performed, why it existed, and the rule it produced are documented once in
-- `20260826052557_tmp_pg17_partial_index_reachability_probe.sql` — read that file.
--
-- This file exists only so `scripts/check-migration-parity.mjs`, which matches on
-- the migration NAME, has a committed artefact for the name prod recorded.
--
-- Net schema effect: NONE. `public._pg17_idx_probe` was created and dropped in the
-- same session. REVERT: nothing to revert.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = '_pg17_idx_probe'
  ) THEN
    RAISE EXCEPTION 'the 2026-08-25 scratch probe table _pg17_idx_probe still exists';
  END IF;
END $$;
