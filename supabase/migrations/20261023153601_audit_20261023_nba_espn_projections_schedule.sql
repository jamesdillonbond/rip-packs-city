-- audit_20261023_nba_espn_projections_schedule
-- Schedules the ESPN NBA lane (20261023 nba_espn_projections_lane). Hourly is enough: ESPN's
-- per-game projection is season-rate, so the hourly value is injury_status (OUT / DAY_TO_DAY) and
-- the next two slates' games. Two drains per dispatch: :21 normally finds all three responses
-- (they land in ~1-3 s); :26 catches a slow one. Positive control before scheduling (8:4x AM PT):
-- one tick wrote 461 projections (281 rankable for 10-23 across 12 games, 180 for 10-24 across 8).
-- Revert: select cron.unschedule('rpc-nba-espn-dispatch'); select cron.unschedule('rpc-nba-espn-drain');
select cron.schedule('rpc-nba-espn-dispatch', '18 * * * *', $c$select public.nba_espn_dispatch()$c$);
select cron.schedule('rpc-nba-espn-drain', '21,26 * * * *', $c$select public.nba_espn_drain()$c$);
