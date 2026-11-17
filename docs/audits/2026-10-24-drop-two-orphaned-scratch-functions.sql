-- docs/audits/2026-10-24-drop-two-orphaned-scratch-functions.sql
-- RUN 2026-10-24 ~8:20 AM PT in the dashboard SQL editor (Claude in Chrome on Trevor's laptop; the
-- Supabase MCP holds DROP statements for a headless session — apply_migration returned "cancelled").
-- Two scratch probes left by the 10-22 / 10-23 sessions (player-hub and search-catalog shapes), carried
-- in the overnight handoff queue as "to DROP". Proved orphaned by MCP read immediately before:
-- 0 cron.job commands, 0 other function bodies, 0 views, 0 pg_stat_user_functions calls, 0 repo
-- references (app/ lib/ scripts/ supabase/functions/ __tests__/); anon + authenticated EXECUTE false.
-- Verified after: select count(*) from pg_proc where proname like 'scratch_2026%' -> 0.
-- REVERT: none — scratch probes with no caller; the real shapes live in get_player_hub / rpc_search_catalog.
DROP FUNCTION public.scratch_20261022_get_player_hub(text);
DROP FUNCTION public.scratch_20261023_search_catalog_joined(text, uuid, integer);
