-- audit_20261003_watch_the_market_cap_and_atlas_supply_lanes
--
-- The two lanes added for market cap today were in NO stall detector:
-- detect_stalled_pipelines() reads pipeline_cadence_watchlist, and neither name was in
-- it. A dead refresh would have left every entity-page tile showing old caps as
-- current; a dead Atlas walk would (after its 3-day gate) quietly turn Golazos and
-- Pinnacle back into "Unknown".
--
--   market-cap-refresh   — pg_cron rpc-market-cap-refresh `41 */2 * * *`; one
--                          pipeline_runs row per successful run (a failed run aborts
--                          before logging, so silence IS the failure signal).
--                          270 min = two missed runs + slack.
--   atlas-edition-supply — pg_cron rpc-atlas-supply-dispatch `17 */6 * * *`, drained by
--                          rpc-atlas-supply-drain within ~5 min; a pipeline_runs row per
--                          drain that had pages, ok only when every page landed.
--                          Silent 400 min = one missed walk + slack; no success for
--                          780 min = two walks failed.
--
-- INSERT only (no existing row is changed); idempotent on the pipeline name.
--
-- Revert: delete the two watchlist rows by pipeline name (human-confirmed).

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, notes)
SELECT v.pipeline, v.silent, v.no_success, 'medium', v.notes
FROM (VALUES
  ('market-cap-refresh', 270, 270,
   'pg_cron rpc-market-cap-refresh 41 */2 (UTC): refresh_market_cap_current() rebuilds market_cap_current (entity-page tiles) + market_cap_daily (7-day change). A failed run aborts before logging, so silence is the failure. Added 2026-10-03.'),
  ('atlas-edition-supply', 400, 780,
   'pg_cron rpc-atlas-supply-dispatch 17 */6 + rpc-atlas-supply-drain 3-58/5: Atlas EditionService supply for Golazos (laliga) + Pinnacle (disney) into atlas_edition_supply. One row per drain with pages; ok only when every page landed. Readers ignore supply older than 3 days. Added 2026-10-03.')
) AS v(pipeline, silent, no_success, notes)
WHERE NOT EXISTS (SELECT 1 FROM public.pipeline_cadence_watchlist w WHERE w.pipeline = v.pipeline);
