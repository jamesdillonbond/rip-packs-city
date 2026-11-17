-- audit_20260823_watchlist_series_detail_rollup
--
-- `series-detail-rollup` is now the ONLY thing keeping 26 indexable series
-- pages answering — get_series_detail reads its table and computes nothing.
--
-- ⚠ A FROZEN ROLLUP PASSES EVERY OTHER CHECK: the pages stay fast, the RPC
-- keeps returning a fully populated row, and the numbers are simply old. There
-- is no other freshness instrument for it, so silence here is the alarm — the
-- same reasoning already recorded on cross-collection-deals-mv.
--
-- 180 min = 3 missed hourly ticks. Full-refresh runtime measured 2026-08-23 as
-- cron_heavy end to end: 99 s cold (Top Shot 69 s of it), ~11 s warm, against
-- the job's own 240 s budget and cron_heavy's 600 s ceiling.
--
-- medium, not high: a stale rollup shows stale aggregates on a working page. It
-- is not the price feed and it does not page.
--
-- Revert: DELETE FROM pipeline_cadence_watchlist WHERE pipeline = 'series-detail-rollup';
INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, is_active, notes)
VALUES (
  'series-detail-rollup',
  180,
  'medium',
  true,
  'pg_cron rpc-series-detail-rollup (jobid 357, 59 * * * *, owner cron_heavy/600s). Recomputes series_detail_rollup, which get_series_detail now reads instead of recomputing six aggregates from 1.16M fmv_snapshots rows per request. Before 2026-08-23 that read cost 21,229 ms warm at 3,600 editions against its own 8 s PostgREST-bound ceiling, so five distinct series URLs were returning HTTP 500 57014 and R19 counted 259 "series detail unavailable" across 38 users in 7 days; it is now 18 ms / 504 buffers at 4,895 editions. 180m = 3 missed hourly ticks. Runtime measured as cron_heavy: 99 s cold, ~11 s warm. ⚠ A FROZEN ROLLUP IS INVISIBLE EVERYWHERE ELSE — the pages stay fast and the RPC still returns a full row, just with old numbers. Silence here is the only alarm.'
)
ON CONFLICT (pipeline) DO UPDATE SET
  max_silent_minutes = EXCLUDED.max_silent_minutes,
  severity = EXCLUDED.severity,
  is_active = EXCLUDED.is_active,
  notes = EXCLUDED.notes;
