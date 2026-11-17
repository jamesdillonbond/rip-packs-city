-- audit_20260920_db_io_snapshot_reads_settings_from_pg_settings_not_current_setting
-- anon-exec: unchanged (ops_db_io_snapshot) — CREATE OR REPLACE of an existing fn; ACL preserved,
-- verified has_function_privilege('anon', …, 'EXECUTE') = false immediately before this migration.
--
-- FIX. The first body did `current_setting('shared_buffers')::bigint`, which fails with
-- 22P02 "invalid input syntax for type bigint: 2GB" — current_setting() returns the setting in its
-- DISPLAY units ('2GB', '12MB'), not the internal 8 kB / kB blocks that pg_settings.setting carries.
-- The whole migration rolled back, so nothing was scheduled and nothing was seeded.
-- ⭐ Worth carrying: current_setting() is the human-readable form, pg_settings.setting is the
-- numeric form with pg_settings.unit telling you the multiplier. They are NOT interchangeable, and
-- the difference only shows up for memory/time settings large enough to be rendered with a suffix —
-- on a small instance `shared_buffers` can render as a bare block count and the cast silently works.

CREATE OR REPLACE FUNCTION public.ops_db_io_snapshot(p_retain_days integer DEFAULT 90, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  WITH ins AS (
    INSERT INTO public.audit_20260920_ops_db_io_snap (
      blks_read, blks_hit, xact_commit, xact_rollback, temp_files, temp_bytes, deadlocks,
      backends, io_wait_backends, active_backends, postmaster_start,
      shared_buffers_mb, work_mem_kb, note)
    SELECT d.blks_read, d.blks_hit, d.xact_commit, d.xact_rollback,
           d.temp_files, d.temp_bytes, d.deadlocks,
           (SELECT count(*) FROM pg_stat_activity),
           (SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'IO'),
           (SELECT count(*) FROM pg_stat_activity WHERE state = 'active'),
           pg_postmaster_start_time(),
           (SELECT (setting::bigint * 8 / 1024)::int FROM pg_settings WHERE name = 'shared_buffers'),
           (SELECT setting::int FROM pg_settings WHERE name = 'work_mem'),
           p_note
    FROM pg_stat_database d
    WHERE d.datname = current_database()
    RETURNING 1)
  DELETE FROM public.audit_20260920_ops_db_io_snap
   WHERE captured_at < now() - make_interval(days => p_retain_days)
     AND (SELECT count(*) FROM ins) >= 0;
$$;