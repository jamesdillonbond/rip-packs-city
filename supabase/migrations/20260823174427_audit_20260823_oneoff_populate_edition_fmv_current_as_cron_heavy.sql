-- ⛔ THIRD TIME THIS RULE HAS BITTEN TODAY, and this time it was mine to know.
--
-- The one-off scheduled as `postgres` died at EXACTLY 120 s:
--   ERROR: canceling statement due to statement timeout
--   CONTEXT: SQL statement "WITH latest AS MATERIALIZED (SELECT DISTINCT ON ..."
-- 120 s is the GLOBAL statement_timeout, which `postgres` inherits because it
-- carries none of its own. My function declares `SET statement_timeout TO '300s'`
-- and that proconfig is INERT under pg_cron — the timer is armed by the top-level
-- CALL before the function's GUC nest level is entered. Only a PostgREST rpc/
-- entry point lets proconfig bind.
--
-- Rescheduling under `cron_heavy`, whose role-level statement_timeout is 600 s.
-- Per the pg_cron permission recipe: apply_migration (NOT execute_sql), SET LOCAL
-- ROLE, then a mandatory RESET ROLE — as `postgres` this would silently create a
-- duplicate job instead.
--
-- ⚠ Also worth recording: the DISTINCT ON pass measured 1.86 s at 06:00 UTC and
-- did not finish in 120 s at 17:39 UTC. Same query, same data volume. Do not
-- quote the 1.86 s as this job's cost — it was a warm reading on a quiet
-- instance, the same error that made me claim "26/26 with full payloads".
--
-- REVERT: SELECT cron.unschedule('rpc-oneoff-edition-fmv-current-heavy');
SET LOCAL ROLE cron_heavy;

SELECT cron.schedule(
  'rpc-oneoff-edition-fmv-current-heavy',
  '* * * * *',
  $$SELECT public.refresh_edition_fmv_current();$$
);

RESET ROLE;