-- 20260909005200_audit_20260909_unschedule_the_historical_sales_backfill_its_scan_is_unbounded
--
-- UNSCHEDULE jobid 481. I shipped it, it caused IO pressure, I pulled it.
--
-- WHAT HAPPENED. `backfill_topshot_sales_from_atlas_events(1500)` with NO `p_since` ran for
-- 246 s in `IO / DataFileRead` and took the instance from 1 active / 0 IO-waiters to
-- 10 active / 8 IO-waiters -- a saturation spell, with my job as the cause. Cancelled and
-- unscheduled by hand at ~00:52Z; instance back to 1 active / 1 IO-waiter / 0 long-running within
-- three minutes. This migration RECORDS that decision so the repo matches prod; it is written
-- idempotently because the unschedule already happened.
--
-- ⭐ ROOT CAUSE IS THIS REPO'S OWN RULE, AND MY VERIFICATION HID IT: **a LIMIT bounds a query's
-- OUTPUT, not its COST.** The candidate CTE runs `NOT EXISTS` against `sales` for every one of
-- ~209k completed events BEFORE `LIMIT 1500` applies. My manual runs looked fast (38 s) only
-- because I passed `p_since = now() - 30 days`, which bounded the scan -- **the cron job passes no
-- `p_since`, so the very argument that made my verification cheap was absent from the thing I
-- scheduled.** ⚠ A verification that does not use the SAME arguments as the scheduled caller is
-- not a verification of it.
--
-- ⚠ Its `SET statement_timeout TO '110s'` did not save it: a function-level SET is INERT on the
-- pg_cron path, so it ran under `cron_heavy`'s 600 s instead.
--
-- ⛔ NOTHING IS LOST AND NOTHING IS ROLLED BACK. The high-value half is already banked and stays:
-- 6,589 rows inside the 30-day FMV window, HIGH+MEDIUM editions 4,301 -> 4,726 (+9.9%), falsifiers
-- clean. Only the ~74,297 HISTORICAL rows are deferred -- they are outside the confidence window and
-- affect edition-page completeness, not FMV. **That is not worth an IO spell.**
--
-- WHAT A CORRECT VERSION NEEDS (specified so it is a cheap pickup, not a re-investigation):
--   * walk a BOUNDED DATE SLICE per tick behind a cursor (e.g. one month of `purchased_at` at a
--     time, newest-first), so each call's scan is proportional to the slice, not the corpus;
--   * or give the function a `p_until` so every call closes its window (`p_since` alone cannot);
--   * keep the `(nft_id, sold_at::date)` dedup key and the DISTINCT ON exactly as they are --
--     those were measured and are correct;
--   * verify with the SAME argument list the schedule will use, in a quiet band, and watch
--     `pg_stat_activity` IO-waiters during the first natural tick.
--
-- The function itself is LEFT IN PLACE and is safe to call by hand with a bounded `p_since`
-- (that is how the FMV window was drained). Only the unbounded schedule is removed.
--
-- anon-exec: no function created or replaced here -- schedule change only.
--
-- REVERT: do NOT simply re-schedule the old command. Fix the bounding first (see above), then
-- schedule the bounded form.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-topshot-sales-atlas-backfill') THEN
    PERFORM cron.unschedule('rpc-topshot-sales-atlas-backfill');
  END IF;
END $$;
