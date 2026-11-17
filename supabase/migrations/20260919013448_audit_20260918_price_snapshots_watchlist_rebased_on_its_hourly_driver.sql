-- audit_20260918_price_snapshots_watchlist_rebased_on_its_hourly_driver
--
-- Follow-through on 20260919001049 (R100). Until tonight `price-snapshots` had no
-- first-party driver: only `rpc-pipeline.yml`, which GitHub delivered ~5 times a day, and
-- a function that wrote one hour per call — so its watchlist row was seeded on that
-- starvation (max_silent 1800 min, no-success 3600 min) and could not see a loss at any
-- threshold (register R100). Two things changed: `rpc-price-snapshots-hourly` (jobid 508,
-- cron_heavy, every hour at :12) now drives it, and the RPC backfills the last 48 hours on
-- every call, so a missed hour is repaired by the next tick rather than lost.
--
-- That makes SILENCE the remaining failure mode worth an arm: the driver stopping. The
-- arm is re-based on the new cadence, not tightened by taste —
--   max_silent_minutes          1800 -> 150  (an hourly tick, 2.5 slots of grace; the
--                                             route's ~5 GHA ticks/day still land between)
--   max_minutes_without_success 3600 -> 300  (GREATEST(3x cadence, 2x max_silent) = 300,
--                                             the same rule the 09-04 seeding used)
-- Measured before this applied (pipeline_runs, 5:1x-6:3x PM PT): the job's own ticks at
-- 5:12 (0.3 s) and 6:12 PM PT (9.7 s), both ok; the last 24 completed hours hold 24 of 24
-- buckets. The DELTA that a silence arm cannot see (hours with sales and no bucket) is
-- published by every run as extra.missing_before / missing_after.
--
-- REVERT: UPDATE public.pipeline_cadence_watchlist SET max_silent_minutes = 1800,
--         max_minutes_without_success = 3600 WHERE pipeline = 'price-snapshots';

UPDATE public.pipeline_cadence_watchlist
   SET max_silent_minutes = 150,
       max_minutes_without_success = 300,
       notes = notes || ' | [RE-BASED 2026-09-18 on the hourly cron_heavy driver rpc-price-snapshots-hourly (jobid 508, :12) + the 48-hour backfill in populate_price_snapshots_hourly (20260919001049): 1800/3600 -> 150/300. Silence is the remaining failure mode; the bucket DELTA is in every run''s extra.missing_before/missing_after.]'
 WHERE pipeline = 'price-snapshots';

DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.pipeline_cadence_watchlist
                  WHERE pipeline = 'price-snapshots' AND max_silent_minutes = 150 AND max_minutes_without_success = 300 AND is_active) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: price-snapshots watchlist row not re-based';
  END IF;
END
$mig$;
