-- audit_20261021: give rpc-panini-holder-concentration a 300 s statement timeout the estate's way.
--
-- The first fill (one-off job 776, 2026-10-21 7:52 AM PT) was killed at 120 s: the function's own
-- `SET statement_timeout TO '300s'` cannot re-arm a statement that is already running (the timer is armed
-- when the cron session's outer `select ...` starts), so the session default won. The refresh's handler
-- logged it honestly (pipeline panini-holder-concentration ok=false, "canceling statement due to statement
-- timeout"). Fix = the pattern jobs 4, 36 and 235 already use: SET as its OWN statement before the call.
--
-- Revert: select cron.alter_job((select jobid from cron.job where jobname='rpc-panini-holder-concentration'),
--           command := 'select public.refresh_panini_holder_concentration()');

SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'rpc-panini-holder-concentration'),
  command := $$SET statement_timeout = '300s'; select public.refresh_panini_holder_concentration()$$
);

SELECT cron.unschedule('zz-panini-holder-first-fill');