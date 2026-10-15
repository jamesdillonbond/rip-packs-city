-- audit_20261015_drop_pre20261015_ownership_mvs
-- Applied 2026-10-15 ~3:30 PM PT from the Windows box (the cloud session's MCP write gate held DROP).
-- Pure cleanup of three objects the 10-15 ownership fix superseded (nothing reads or schedules them):
--   * the two pre-fix MVs 20261015200615 renamed aside (pg_cron jobs 40/41 refresh the NEW MVs by name);
--   * refresh_topshot_edition_concentration() v1 — pg_cron job 682 calls _v2 since 20261015215728.
-- Preconditions re-read live before applying, each 0 rows: no function body names _mv_pre20261015, no cron
-- command does, no cron command or function body calls refresh_topshot_edition_concentration(); 0 views
-- depend on either MV; no caller in app/lib/supabase/functions/scripts/.github. No CASCADE on purpose.
-- Revert: none needed for the MVs; for v1, re-apply its body from 20261015200615's lineage
-- (live prosrc md5 0a6d02aac9e5792565e3c41cec06dd65, last committed with 20261003184843).
DROP MATERIALIZED VIEW IF EXISTS public.topshot_rookie_collector_leaderboard_mv_pre20261015;
DROP MATERIALIZED VIEW IF EXISTS public.topshot_set_completers_mv_pre20261015;
DROP FUNCTION IF EXISTS public.refresh_topshot_edition_concentration();
