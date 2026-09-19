-- 2026-09-18 evening audit (Cowork cloud). AUTHORED 22:40 PT 09-18 = 05:40Z 09-19.
--
--   rpc-ts-listings-atlas-sync (jobid 466, owner postgres, active)  '*/2 * * * *' -> '*/6 * * * *'
--
-- A TEMPORARY STABILISATION, not a considered cadence. Nothing else changes: the command,
-- atlas_listing_verify_tick(2), is untouched.
--
-- ⚠ I FILED THIS SAME CHANGE AS "DELIBERATELY NOT SHIPPED" TWENTY MINUTES AGO AND THE REASON I GAVE
--   WAS WRONG. I framed it as a product decision -- "*/2 vs */6 is 2-minute vs 6-minute listing
--   latency on a public surface, Trevor's call". That is the trade when the lane WORKS. It is not
--   the trade on the table. Measured at 22:33 PT: 7 of the last 8 ticks failed, 14 of 14 across the
--   22:00 half-hour, every one at the 120 s ceiling, and ts_listings' newest ingested_at is
--   38.3 minutes old. THE EFFECTIVE CADENCE IS ALREADY INFINITE. The real comparison is
--   "6-minute staleness" against "no updates at all", and on that comparison there is no product
--   call to defer -- only a maintenance one, and it is unambiguous.
--   ⭐ The reusable error: I compared the candidate against the lane's DESIGNED behaviour instead of
--      against its MEASURED behaviour, and deferring on that comparison would have left users on a
--      frozen board to protect a freshness guarantee the lane was no longer providing.
--
-- WHY IT CANNOT MAKE THINGS WORSE, which is the whole basis for taking it unsupervised:
--   Output is currently ZERO. Any restored tick is a strict improvement on the measured state.
--
-- THE RATCHET IT BREAKS (arithmetic, not a theory): dispatched every 2 minutes with each failing
-- tick burning its full 120 s ceiling, the lane runs at a ~100 % duty cycle while producing
-- nothing -- its own retries are the load preventing its own success, so it cannot recover on its
-- own once it tips. At '*/6' the duty cycle is at most ~33 %. When the box is calm this lane
-- completes in 9-17 s, so a 360 s window leaves it finishing in a twentieth of its slot.
--
-- AND THE STRUCTURE IS NOT NEW: the 01:30Z filing measured this lane across seven days and found
-- NO quiet hour at all -- 7.2-55.2 % timeouts in every hour-of-day at 25-85 s average. A job
-- averaging 25-85 s against a 120 s ceiling, dispatched every 120 s, has no headroom by
-- construction. Tonight is that structure meeting a loaded box.
--
-- ⚠ THE REAL COST, STATED: each tick also re-reads a small number of individual listings so
--   cancellations flip (the command's argument is 2). That leg is throughput-limited by cadence,
--   so this change cuts re-verification from ~2,160/day to ~720/day against a 69,111-row table.
--   TODAY IT IS ZERO PER DAY, so this is still strictly better -- but it is a real reduction against
--   a HEALTHY '*/2' and must not be left in place as if it were free.
--   👉 THE PROPER FIX, once the lane is measurable again: '*/6' with atlas_listing_verify_tick(6),
--      holding daily verification throughput constant while paying the ts_listings rebuild a third
--      as often. NOT DONE HERE because the per-N cost profile has not been measured, and measuring
--      it means running the tick on a box that is already saturated.
--
-- ⛔ NOT a claim on R108 or on the other session's Atlas work. Different object: R108's fix is a
--    partial index on topshot_atlas_market_events. This is one cron schedule and touches no DDL.
--
-- ⚠ CHANGE POINT 2026-09-18 22:40 PT. Split any jobid 466 rate on it.
--    Pre-change record, 30-minute buckets PT, 15 runs each: 13:30-15:00 0 % fail (avg 9.2-16.8 s) ·
--    15:30 27 % · 16:00 20 % · 16:30-18:00 0 % · 18:30 27 % · 19:00 87 % · 19:30 53 % · 20:00 33 % ·
--    20:30 73 % · 21:00 80 % · 21:30 47 % · 22:00 100 % (avg 121.9 s).
--
-- FALSIFIER: if the lane is still at or near 100 % failure two hours after this applies, the
--   cadence was not the binding constraint and this must be reverted rather than left as a
--   permanent throughput reduction that bought nothing.
-- NO-CHANGE CONTROL: rpc-allday-unmapped-atlas-resolver ('4-59/5', untouched, same 689 MB table per
--   R108). If IT recovers by the same margin over the same hours, the estate calmed down and this
--   change is not what did it.
--
-- REVERT: select cron.alter_job(466, schedule => '*/2 * * * *');

DO $mig$
DECLARE
  v_before text;
  v_after  text;
  v_cmd    text;
  v_active boolean;
BEGIN
  SELECT schedule, command, active INTO v_before, v_cmd, v_active
    FROM cron.job WHERE jobid = 466 AND jobname = 'rpc-ts-listings-atlas-sync';

  IF v_before IS NULL THEN
    RAISE EXCEPTION 'jobid 466 is not rpc-ts-listings-atlas-sync - refusing to move a job I cannot identify';
  END IF;

  IF v_before = '*/6 * * * *' THEN
    RAISE NOTICE 'lane already backed off - no change';
    RETURN;
  END IF;

  IF v_before <> '*/2 * * * *' THEN
    RAISE EXCEPTION 'lane is not on the measured schedule (found %) - re-derive before changing it',
      v_before;
  END IF;

  PERFORM cron.alter_job(466, schedule => '*/6 * * * *');

  SELECT schedule, command, active INTO v_after, v_cmd, v_active FROM cron.job WHERE jobid = 466;

  IF v_after <> '*/6 * * * *' THEN
    RAISE EXCEPTION 'back-off did not take (found %)', v_after;
  END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'lane came out INACTIVE - this migration slows it, it does not stop it';
  END IF;
  IF v_cmd NOT LIKE '%atlas_listing_verify_tick%' THEN
    RAISE EXCEPTION 'lane command changed (%) - this migration changes WHEN, never WHAT', v_cmd;
  END IF;

  RAISE NOTICE 'ts-listings lane backed off % -> %, still active, command unchanged', v_before, v_after;
END
$mig$;
