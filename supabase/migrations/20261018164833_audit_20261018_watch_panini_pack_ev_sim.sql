-- Watch the new hourly Panini pack simulation lane (20261018162610) so its silence pages.
--
-- WHY (2026-10-18 ~9:50 AM PT, Claude Code cloud): a lane with no cadence-watchlist row can stop
-- unnoticed. The board already fails closed (it hides a sim older than 3 h), so a stall is never
-- user-deceptive — severity info — but an operator should still learn the job stopped.
-- REVERT: DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline='panini-pack-ev-sim';

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, notes, is_active)
VALUES ('panini-pack-ev-sim', 150, 300, 'info',
  'pg_cron rpc-panini-pack-ev-sim (58 * * * *) -> refresh_panini_pack_ev_sim(): 20,000 simulated WC Hobby packs -> panini_pack_ev_sim (migration 20261018162610, 2026-10-18 PT). Silence = the job stopped; ok=false = the run failed and wrote ok=false/error (the board then serves no sim, fail-closed). Thresholds: hourly lane, 150 min silent = two missed ticks; 300 min without success. info: the board hides a sim older than 3 h, so a stall is never user-deceptive. Revert: DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline=''panini-pack-ev-sim'';',
  true)
ON CONFLICT (pipeline) DO NOTHING;
