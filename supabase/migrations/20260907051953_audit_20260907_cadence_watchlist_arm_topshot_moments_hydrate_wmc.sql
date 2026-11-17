-- audit_20260907: cadence watchlist row for the new pg_cron hydrator (jobid 468, 19,35,55 * * * *).
-- 70 min silent = three missed ticks; 140 min without a success. Health is SILENCE, not
-- rows_written: a pass over the queue writes ~1,300 rows per tick until the ~50K wmc-resolvable
-- rows are drained, then a trickle (new pulls + newly walked wallets) — rows_written 0 on a tick is
-- expected once a pass has passed the resolvable rows.
-- REVERT: DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'topshot-moments-hydrate-wmc';
INSERT INTO public.pipeline_cadence_watchlist (pipeline, severity, is_active, max_silent_minutes, max_minutes_without_success, notes)
VALUES (
  'topshot-moments-hydrate-wmc', 'medium', true, 70, 140,
  'pg_cron jobid 468 rpc-topshot-moments-hydrate-wmc, 19,35,55 * * * * since 2026-09-07 (migration audit_20260907_hydrate_topshot_moments_from_wmc). Hydrates public.moments for pack-pulled Top Shot nfts from wallet_moments_cache; ~1,300 rows/tick while the 50K resolvable backlog drains, then a trickle. 70 min = 3 missed ticks. rows_written 0 is NOT a failure after the resolvable rows have been passed.'
)
ON CONFLICT (pipeline) DO UPDATE SET severity = EXCLUDED.severity, is_active = true,
  max_silent_minutes = EXCLUDED.max_silent_minutes, max_minutes_without_success = EXCLUDED.max_minutes_without_success,
  notes = EXCLUDED.notes;
