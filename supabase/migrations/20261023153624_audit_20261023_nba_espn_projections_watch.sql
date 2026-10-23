-- audit_20261023_nba_espn_projections_watch
-- #8 sat 18 days dark in August because sync-nba-projections had NO cadence arm. The ESPN lane gets
-- one from birth. nba_espn_drain() logs one pipeline_runs row per tick that drained >= 1 request
-- (hourly, :21); ok = false when a request failed OR games exist today and zero projections were
-- written (the #8 rule: judge by rows for today's games, not by the ok flag).
-- Bars: 150 min silent = two missed hourly ticks; 360 min without success = six failed ticks.
-- Revert: update public.pipeline_cadence_watchlist set is_active = false where pipeline = 'nba-espn-projections';
insert into public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, notes)
values ('nba-espn-projections', 150, 360, 'medium',
 'Added 2026-10-23 with the ESPN NBA lane (nba_espn_dispatch :18 / nba_espn_drain :21,:26, pg_cron 783/784), which replaces the dead sync-nba-projections upstreams for #8. Drain logs once an hour; ok=false on any request error or on games-today-with-zero-projections. Positive control 10-23 8:4x AM PT: 461 projections in one tick (281 rankable for 10-23, 12 games).')
on conflict (pipeline) do update
  set max_silent_minutes = excluded.max_silent_minutes,
      max_minutes_without_success = excluded.max_minutes_without_success,
      severity = excluded.severity, notes = excluded.notes, is_active = true;
