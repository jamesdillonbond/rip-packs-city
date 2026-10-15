-- audit_20261015_market_superseded_functions_drop
-- NOT APPLIED: the Supabase MCP holds every DROP in headless sessions (timed out
-- 2026-10-14 ×4 and 2026-10-15 ×1; the statement never reached Postgres). Run
-- from the dashboard SQL editor, then `git mv` into supabase/migrations/ with a
-- timestamp prefix.
--
-- Functions the Market filter work superseded (2026-10-14/15). Each has NO caller:
--   get_market_team_options(uuid)          → replaced by get_market_filter_options (route deleted in 2435f43)
--   get_allday_market_editions (v1, 10-arg) → /api/market moved to _v2 then _v3; nothing else calls v1
--   get_allday_market_editions_v2           → /api/market moved to _v3 (2026-10-15)
--   get_topshot_sniper_deals_v2             → /api/market moved to _v3 (2026-10-15)
-- KEEP get_topshot_sniper_deals (v1): /api/sniper-feed and /api/cron/warm call it.
-- The two zz_probe functions are dropped by
-- docs/pending-sql/audit_20261015_fmv_snapshots_touch_updated_at_and_drop_zz_probes.sql.
--
-- BEFORE RUNNING, confirm no caller appeared (each should return 0 rows):
--   SELECT proname FROM pg_proc WHERE prosrc ~ '(get_market_team_options|get_allday_market_editions\(|get_allday_market_editions_v2|get_topshot_sniper_deals_v2)';
--   SELECT jobname FROM cron.job WHERE command ~ '(get_market_team_options|get_allday_market_editions|_v2\()';
--   and `grep -rn "get_allday_market_editions\b\|_v2\"" app lib supabase/functions` in the repo.
--
-- REVERT: re-run the creating migrations 20261015020243 (team options),
--   20261010085932's lineage for AD v1, 20261015033610 (both _v2).
DROP FUNCTION IF EXISTS public.get_market_team_options(uuid);
DROP FUNCTION IF EXISTS public.get_allday_market_editions(numeric, numeric, text, text, text, integer, text[], text[], text, numeric);
DROP FUNCTION IF EXISTS public.get_allday_market_editions_v2(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean);
DROP FUNCTION IF EXISTS public.get_topshot_sniper_deals_v2(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean);
