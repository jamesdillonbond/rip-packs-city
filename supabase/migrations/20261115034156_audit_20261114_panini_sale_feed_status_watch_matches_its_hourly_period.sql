-- 2026-11-14 (Claude Code cloud, ~8:45 PM PT; Trevor forwarded the 7:04 PM PT sentinel WARN).
--
-- WHY. Sentinel "Pipeline Silence: panini-sale-feed-status-refresh silent 110m (>95m, info)". One run
-- (6:14 PM PT) hit its 120 s statement_timeout — a kill writes no pipeline_runs row — and 7:14 PM
-- recovered (68 s, ok). Nothing user-facing: the view's snapshot window (2 h 15 m) is built to serve
-- through exactly one missed hourly tick (20261110222110).
--
-- The ALARM was not rescaled with the job. max_silent_minutes = 95 was set 10-10 as "~3x the measured
-- period" when job 714 ran every 30 min; 20261110222110 moved it to hourly and kept 95 / 185 — so the
-- watch now fires on the FIRST missed tick, the very case the view was designed to absorb. Same ratio,
-- new period: 185 min silent (~3 periods: one miss is absorbed, a second WARNs while the view's 2h15m
-- window is about to lapse) and 245 min without success. Severity stays info.
--
-- Recorded, not changed here: each run full-scans panini_card_serials (7.2 GB heap, 5.46M rows) for
-- five counters, 47–87 s today against a 120 s budget (22–30 s on 11-10) — the margin is closing as the
-- table grows. Lever for a later pass: maintain the counters incrementally, or read a sampled / indexed
-- estimate for the disclosure that is its only reader.
--
-- Revert: UPDATE public.pipeline_cadence_watchlist SET max_silent_minutes = 95, max_minutes_without_success = 185
--         WHERE pipeline = 'panini-sale-feed-status-refresh';
UPDATE public.pipeline_cadence_watchlist
   SET max_silent_minutes = 185,
       max_minutes_without_success = 245,
       notes = notes || ' | 2026-11-14: rescaled to the hourly period (20261110222110 moved job 714 from 30 to 60 min and kept 95/185): 185 silent / 245 without success, ~3 periods, so one missed tick (which the view absorbs) does not WARN.'
 WHERE pipeline = 'panini-sale-feed-status-refresh'
   AND max_silent_minutes = 95;
