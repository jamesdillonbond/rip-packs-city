-- audit_20261126_ts_sold_floor_clear_off_the_drain_minutes
--
-- Claude Code cloud, 2026-11-26 ~7:10 AM PT. pg_cron rpc-ts-sold-floor-clear (jobid 825) moves its six ODD-minute ticks
-- back one minute: 5,10,15,25,30,35,45,50,55 -> 4,10,14,24,30,34,44,50,54. Same nine ticks an hour, max gap 10 min
-- (the watchlist allows 25), the function and its arguments untouched.
--
-- WHY: close_sold_topshot_listings_and_floors() and atlas_market_drain() both update topshot_atlas_market_events rows
-- (completed = true / the feed upsert) in different orders, and deadlock when they overlap. The drain runs on every ODD
-- minute (1-59/2, avg 13 s, p95 29 s); this job started on odd minutes 6 times an hour (avg 17 s, p95 35 s), so those
-- ticks started in the same second as a drain. Postgres logged the ts-sold-floor-clear side of this deadlock at
-- 4:25 PM, 6:25 PM and 9:15 PM PT 11-25 and 8:25 AM and 12:45 PM PT 11-24 — every one on an odd minute where both start.
-- On an even minute the drain is idle: an overlap now needs a drain or this job to run past 60 s (rare tail).
--
-- Rejected: serialising the two on the drain's advisory lock. The drain takes it with pg_try_advisory_xact_lock and
-- SKIPS when held, so it would skip ~6 of its 30 ticks an hour, delaying the market feed to cure ~3 self-healing
-- failures a day. Rejected: SKIP LOCKED in the floor arm — a skipped sold listing stays open after its floor is
-- cleared, the next ts-listings-atlas-sync can re-read it as the floor at a newer confirmed_at, and nothing clears it.
--
-- Load: pg_cron seconds started per hour (24 h, 11-26): minute 4 = 36, 5 = 55, 14 = 63, 15 = 114, 24 = 56, 25 = 62,
-- 34 = 78, 35 = 62, 44 = 35, 45 = 98, 54 = 78, 55 = 40. The job's ~17 s moves with it; no new job, lane budget unchanged.
--
-- REVERT: SELECT cron.alter_job(825, schedule := '5,10,15,25,30,35,45,50,55 * * * *'); and restore the watchlist note's
-- leading "at 5,10,15,25,30,35,45,50,55".

DO $$
BEGIN
  IF (SELECT schedule FROM cron.job WHERE jobid = 825 AND jobname = 'rpc-ts-sold-floor-clear') IS DISTINCT FROM '5,10,15,25,30,35,45,50,55 * * * *' THEN
    RAISE EXCEPTION 'rpc-ts-sold-floor-clear schedule changed since it was read; re-derive before moving it';
  END IF;
END $$;

SELECT cron.alter_job(825, schedule := '4,10,14,24,30,34,44,50,54 * * * *');

UPDATE public.pipeline_cadence_watchlist
   SET notes = replace(notes, 'rpc-ts-sold-floor-clear at 5,10,15,25,30,35,45,50,55:',
                              'rpc-ts-sold-floor-clear at 4,10,14,24,30,34,44,50,54 (even minutes, off the atlas_market_drain odd minutes, 2026-11-26):')
 WHERE pipeline = 'ts-sold-floor-clear';
