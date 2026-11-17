-- The first population exceeds the Supabase MCP's 60 s tool cap under daytime
-- load (it measured 1.86 s at 06:00 UTC on a quiet instance; the instance is not
-- quiet now). A tool timeout is NOT a cancellation, but the transaction rolled
-- back both times and the table stayed empty.
--
-- Established recipe for work that outlives the MCP cap: a one-off pg_cron job,
-- which runs server-side with cron_heavy's 600 s ceiling. UNSCHEDULED in the
-- companion migration as soon as the table is populated.
--
-- REVERT: SELECT cron.unschedule('rpc-oneoff-edition-fmv-current');
SELECT cron.schedule(
  'rpc-oneoff-edition-fmv-current',
  '* * * * *',
  $$SELECT public.refresh_edition_fmv_current();$$
);