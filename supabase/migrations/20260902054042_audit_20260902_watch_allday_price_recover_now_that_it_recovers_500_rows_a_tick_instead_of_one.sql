-- audit_20260902_watch_allday_price_recover_now_that_it_recovers_500_rows_a_tick_instead_of_one
--
-- `allday-price-recover` is not on pipeline_cadence_watchlist. Nothing notices if it dies.
--
-- That mattered little when it recovered ONE row per tick. As of this evening's claim fix it recovers
-- ~500, and it is now the pipeline draining the 9,859-row AllDay V1 price backlog into `sales` — FMV
-- input, on the roadmap's accuracy gate. An unwatched pipeline doing the most valuable recovery work
-- on the platform is the gap worth closing.
--
-- ⚠ THE THRESHOLD IS MEASURED, NOT DERIVED FROM THE SCHEDULE. Over 228 inter-run gaps in 7 days:
-- min 17 min, avg 20, **max 40**. The nominal cadence is 20 minutes, so the obvious 60 would sit only
-- 1.5× above the OBSERVED worst case and would page on an ordinary skipped tick. 90 minutes is ~4.5
-- ticks of headroom and matches `lock-check-batch`, whose cadence is comparable.
--
-- ⓘ It will legitimately go QUIET-BUT-NOT-SILENT once the backlog drains (~6 h): the Vercel cron fires
-- regardless and always writes a `pipeline_runs` row, so `rows_written` falls to 0 while `ok` stays
-- true. That is fine for both arms — `detect_stalled_pipelines()` keys on the last run's TIME, and
-- `check_pipelines_running_but_not_succeeding()` requires `ok_runs = 0`, so a drained pipeline is
-- silent rather than noisy. **Silence here means the cron stopped, which is exactly what we want to
-- hear about.**
--
-- ⛔ NOT added, deliberately, and each for a stated reason:
--   • `topshot-buyer-backfill-historical` — as of tonight it is drained BY DESIGN (0 candidates); a
--     stall arm on a lane with nothing to do reports on the cron, not on the work.
--   • `resolve-topshot-stubs` — 37 rows written in 74,800 attempts over 36 days; watching its CADENCE
--     would say nothing about the thing that is wrong with it.
--   • `topshot-subedition-circulation-backfill` — its upstream is down, and as of tonight it correctly
--     reports ok=false. Adding it now would create a permanently-red arm, which CLAUDE.md records as
--     indistinguishable from a broken one.
--
-- REVERT: DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'allday-price-recover';

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active)
VALUES (
  'allday-price-recover',
  90,
  'medium',
  'Vercel cron, nominal every 20 min. Threshold from MEASURED gaps (7 d, 228 gaps: min 17 / avg 20 / '
  'max 40), not from the nominal cadence — 60 would page on an ordinary skipped tick. Drains the AllDay '
  'V1-Dapper price backlog into sales via promote_unmapped_sales, so it is FMV input. Goes quiet-but-'
  'not-silent when drained (ok=true, rows_written=0), which neither arm reports; silence means the cron '
  'stopped. Added 2026-09-02 after the singleton-tx claim took it from 1 row/tick to ~500.',
  true
)
ON CONFLICT (pipeline) DO NOTHING;

DO $mig$
DECLARE
  v_rows int;
  v_max_gap int;
  v_silent int;
BEGIN
  SELECT count(*) INTO v_rows FROM public.pipeline_cadence_watchlist WHERE pipeline = 'allday-price-recover';
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: expected exactly 1 watchlist row, found %', v_rows;
  END IF;

  SELECT max_silent_minutes INTO v_silent
  FROM public.pipeline_cadence_watchlist WHERE pipeline = 'allday-price-recover';

  -- ⛔ THE THRESHOLD MUST CLEAR THE OBSERVED WORST CASE, or the arm pages on normal operation and is
  -- switched off — which is worse than not having it. Re-derived here rather than trusted from the
  -- header, so the assertion fails if the cadence has changed since this was written.
  SELECT ceil(max(extract(epoch from gap) / 60))::int INTO v_max_gap
  FROM (
    SELECT started_at - lag(started_at) OVER (ORDER BY started_at) AS gap
    FROM public.pipeline_runs
    WHERE pipeline = 'allday-price-recover' AND started_at > now() - interval '7 days'
  ) g WHERE gap IS NOT NULL;

  IF v_max_gap IS NULL THEN
    RAISE EXCEPTION 'POST-STATE FAILED: no runs in 7 days — refusing to set a threshold with no evidence';
  END IF;
  IF v_silent <= v_max_gap THEN
    RAISE EXCEPTION 'POST-STATE FAILED: threshold % min is below the observed max gap of % min — it would page on normal operation',
      v_silent, v_max_gap;
  END IF;

  RAISE NOTICE 'post-state ok: watching allday-price-recover at % min against an observed max gap of % min',
    v_silent, v_max_gap;
END
$mig$;
