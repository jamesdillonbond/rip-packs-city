-- One-off under cron_heavy to exercise the rewritten refresh end to end before
-- the :59 tick does, so a failure surfaces now rather than silently at night.
-- Unscheduled immediately after; the run is idempotent.
-- Baseline rollup md5 before this run: 68b12ab2286071c21fb06014aae96bad (26 rows).
SET LOCAL ROLE cron_heavy;
SELECT cron.schedule(
  'rpc-oneoff-verify-series-rollup',
  '* * * * *',
  $$SELECT public.refresh_series_detail_rollup(240);$$
);
RESET ROLE;