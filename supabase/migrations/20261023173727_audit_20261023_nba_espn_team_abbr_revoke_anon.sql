-- audit_20261023_nba_espn_team_abbr_revoke_anon
-- 20261023153445 created public.nba_espn_team_abbr(int) (a pure ESPN team id -> code map) without an
-- anon-execute decision; public functions are anon-executable by default on this database. Its only
-- caller is nba_espn_drain(), which runs as postgres under pg_cron 784, so no API role needs it.
-- Caught by __tests__/migration-new-function-states-its-anon-exec-decision.test.ts before the push.
-- Revert: grant execute on function public.nba_espn_team_abbr(int) to anon, authenticated;
revoke execute on function public.nba_espn_team_abbr(int) from public, anon, authenticated;
