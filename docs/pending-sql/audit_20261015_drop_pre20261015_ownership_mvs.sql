-- audit_20261015_drop_pre20261015_ownership_mvs
-- ⏸ PENDING — NOT APPLIED (the cloud session's MCP write gate holds DROP).
-- Pure cleanup of three objects the 10-15 ownership fix superseded (nothing reads or schedules them):
--   * the two pre-fix MVs 20261015200615 renamed aside (pg_cron jobs 40/41 refresh the NEW MVs by name);
--   * refresh_topshot_edition_concentration() v1 — pg_cron job 682 calls _v2 since 20261015215728.
-- Preconditions (each must return 0 rows):
--   SELECT proname FROM pg_proc WHERE prosrc ILIKE '%_mv_pre20261015%';
--   SELECT jobid FROM cron.job WHERE command ILIKE '%_mv_pre20261015%';
--   SELECT jobid FROM cron.job WHERE command ~ 'refresh_topshot_edition_concentration\(\)';
-- Revert: none needed for the MVs; for v1, re-apply its body from 20261015200615's lineage
-- (live prosrc md5 0a6d02aac9e5792565e3c41cec06dd65, last committed with 20261003184843).
DROP MATERIALIZED VIEW IF EXISTS public.topshot_rookie_collector_leaderboard_mv_pre20261015;
DROP MATERIALIZED VIEW IF EXISTS public.topshot_set_completers_mv_pre20261015;
DROP FUNCTION IF EXISTS public.refresh_topshot_edition_concentration();
