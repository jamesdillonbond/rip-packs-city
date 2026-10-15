-- audit_20261015_drop_pre20261015_ownership_mvs
-- ⏸ PENDING — NOT APPLIED (the cloud session's MCP write gate holds DROP).
-- 20261015200615 renamed the two pre-fix MVs aside instead of dropping them. They have no reader
-- and no refresh job (pg_cron jobs 40/41 refresh the NEW MVs by name). Pure disk cleanup.
-- Precondition (both must return 0 rows):
--   SELECT proname FROM pg_proc WHERE prosrc ILIKE '%_mv_pre20261015%';
--   SELECT jobid FROM cron.job WHERE command ILIKE '%_mv_pre20261015%';
-- Revert: none needed (the live MVs are the 20261015200615 definitions).
DROP MATERIALIZED VIEW IF EXISTS public.topshot_rookie_collector_leaderboard_mv_pre20261015;
DROP MATERIALIZED VIEW IF EXISTS public.topshot_set_completers_mv_pre20261015;
