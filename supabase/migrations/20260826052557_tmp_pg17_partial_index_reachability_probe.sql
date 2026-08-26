-- tmp_pg17_partial_index_reachability_probe
--
-- RECORD-ONLY, and it records a MISTAKE as much as a change.
--
-- Three migrations were applied via the Supabase MCP on 2026-08-25 PT that were
-- pure DIAGNOSTIC scratch — a throwaway table used to prove, in both directions,
-- that PostgreSQL 17 cannot use a partial index whose predicate carries
-- `<col> IS NOT NULL` on a column declared NOT NULL:
--
--   20260826052557  tmp_pg17_partial_index_reachability_probe
--   20260826052616  tmp_pg17_probe_control_index
--   20260826052652  tmp_pg17_probe_cleanup          -- dropped the scratch table
--
-- Net schema effect: NONE. `public._pg17_idx_probe` was created and dropped in the
-- same session; nothing it touched still exists.
--
-- ⚠ THE LESSON, WHICH IS THE REASON THIS FILE EXISTS AT ALL.
-- CLAUDE.md says "`apply_migration` for DDL; `execute_sql` for reads/verification".
-- Read literally that sends DIAGNOSTIC DDL through `apply_migration` — and every
-- `apply_migration` writes a permanent row to `supabase_migrations.schema_migrations`,
-- which `scripts/check-migration-parity.mjs` then requires a committed file for,
-- forever. So a throwaway probe leaves a permanent parity obligation for an object
-- that no longer exists.
--
-- ⭐ Sharper rule: use `apply_migration` for DDL THAT SHOULD BE PART OF THE SCHEMA
-- RECORD. Use `execute_sql` for scratch DDL that exists only to answer a question —
-- it writes no version row, so it creates no obligation. (`execute_sql` wraps a
-- transaction, so it cannot carry CONCURRENTLY; that path is still the one-off
-- pg_cron recipe.)
--
-- REVERT: nothing to revert — the scratch object is already gone.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = '_pg17_idx_probe'
  ) THEN
    RAISE EXCEPTION 'the 2026-08-25 scratch probe table _pg17_idx_probe still exists — '
                    'it should have been dropped in the same session';
  END IF;
END $$;
