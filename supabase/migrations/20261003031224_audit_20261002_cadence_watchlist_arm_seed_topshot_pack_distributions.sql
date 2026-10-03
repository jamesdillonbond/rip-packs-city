-- audit_20261002: cadence watchlist row for `seed-topshot-pack-distributions`.
--
-- The edge function seeds the Top Shot pack-distribution catalog that Top Shot
-- pack EV reads, every 4 h at :13 (5 invocations in the 24 h to 2026-10-02 8 PM PT,
-- all 202, per function_edge_logs). Until the same-day commit it wrote NO
-- pipeline_runs row on ANY outcome: a failed catalog walk was a console line
-- behind a 202 — invisible to every sentinel arm. Found by
-- supabase/functions/_tests/failed_run_honesty_test.ts (rule 3). The function now
-- writes one log_pipeline_run row per run (ok=false on a thrown walk/upsert AND on
-- an empty catalog, which Top Shot never genuinely has).
--
-- NUMBERS from the cadence, on the estate's seeded convention: 4 h cadence ->
-- 720 min silent = 3 missed ticks; 1440 min without success = 2x.
-- SEVERITY `medium`: visibility, does not page (a lane is promoted only after a
-- user-facing regression is traced to it — the estate's precedent).
--
-- ⚠ detect_stalled_pipelines() carries a new-row grace (created_at + max_silent),
-- so this row cannot fire before its first rows have had time to land.
--
-- Revert: DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'seed-topshot-pack-distributions';
INSERT INTO public.pipeline_cadence_watchlist
  (pipeline, max_silent_minutes, max_minutes_without_success, severity, notes, is_active)
VALUES (
  'seed-topshot-pack-distributions',
  720,
  1440,
  'medium',
  'Edge fn seed-topshot-pack-distributions (Top Shot pack-distribution catalog for pack EV), every 4 h at :13. Wrote NO pipeline_runs row before 2026-10-02; now one per run, ok=false on a failed walk/upsert or an empty catalog. 720 = 3 missed ticks, 1440 = 2x. medium = visibility.',
  true
)
ON CONFLICT (pipeline) DO NOTHING;
