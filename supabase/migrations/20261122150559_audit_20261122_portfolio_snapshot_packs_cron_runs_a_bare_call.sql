-- audit_20261122_portfolio_snapshot_packs_cron_runs_a_bare_call
--
-- 2026-11-22 ~7:25 AM PT (Claude Code cloud; Trevor: "Keep going and working through this").
-- WHY. pg_cron `rpc-portfolio-snapshot-packs` (scheduled by 20261122023120) FAILED both of its runs
-- (11-22 07:56Z and 11:56Z): `ERROR: invalid transaction termination ... fill_portfolio_snapshot_pack_values
-- line 32 at COMMIT`. Its command was `SET statement_timeout = '300s'; CALL ...` -- a multi-statement
-- command is sent as ONE implicit transaction block, so the procedure's per-row COMMIT is illegal
-- (CLAUDE.md: "a SET ...; prefix makes a pg_cron command a TRANSACTION BLOCK"). Result: 0 of 58 portfolio
-- snapshots got a pack value on 11-20, 11-21 or 11-22 and the lane never wrote a pipeline_runs row.
-- WHAT. The command becomes a bare `CALL` (its own implicit transaction, so COMMIT works). Without the SET the
-- call inherits the 120 s role default, so the soft budget drops 240 -> 100 s and the job runs hourly
-- 07:56-11:56Z (5 slices x 100 s) instead of twice; each run resumes the rows still NULL for CURRENT_DATE.
-- Procedure unchanged. Job looked up by name, not id.
-- REVERT: SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rpc-portfolio-snapshot-packs'),
--   schedule := '56 7,11 * * *',
--   command := 'SET statement_timeout = ''300s''; CALL public.fill_portfolio_snapshot_pack_values(240);');
--   (which restores the failing state).

SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'rpc-portfolio-snapshot-packs'),
  schedule := '56 7,8,9,10,11 * * *',
  command  := 'CALL public.fill_portfolio_snapshot_pack_values(100);'
);
