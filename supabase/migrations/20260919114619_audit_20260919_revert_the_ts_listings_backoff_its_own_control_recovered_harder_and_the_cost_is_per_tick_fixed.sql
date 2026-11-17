-- 2026-09-19 early morning (Cowork cloud). AUTHORED 04:50 PT 09-19 = 11:50Z.
--
--   rpc-ts-listings-atlas-sync (jobid 466)  '*/6 * * * *'  ->  '*/2 * * * *'
--
-- REVERTS migration 20260919064000, shipped 22:40 PT 09-18. Nothing else changes.
--
-- WHY THE REVERT. The back-off was taken as a temporary stabilisation on the argument that a
-- ~100 % duty cycle of failing ticks was its own load. Six hours of evidence say it bought
-- nothing, and three separate measurements say the cadence was never the binding knob:
--
--  1. ⛔ NO-CHANGE CONTROL RECOVERED HARDER. rpc-allday-unmapped-atlas-resolver (jobid 464,
--     '4-59/5', untouched, same 689 MB table) went 55 % fail pre (12/22) -> 32 % post (8/25) and
--     0 % fail -- 9 of 9 -- from 00:00 PT. The CHANGED lane was still mixed over the same hours.
--     Both lanes recover at the same instant. THE ESTATE CALMED DOWN; '*/6' is not what did it.
--     ⭐ A candidate whose own control outperforms it has not been shown to work.
--
--  2. ⛔ THE FIRST 80 MINUTES AT '*/6' WERE 100 % FAILURE (15 of 15, 22:42 -> 00:00 PT). If the
--     duty cycle were the constraint, relief should have appeared inside one or two windows.
--
--  3. ⛔ THE FAILING WORK IS PER-TICK FIXED, SO CADENCE CANNOT REACH IT. Of 17 post-change
--     timeouts, 12 are the two temp-table builds -- 'CREATE TEMP TABLE _cl_want ... DISTINCT ON
--     (ev.nft_id...)' (6) and '_tsl_want ...' (6). Those cost the same whether the tick runs every
--     2 minutes or every 6. ⭐ This also retires the follow-up the 09-18 filing proposed:
--     '*/6' + atlas_listing_verify_tick(6) would hold verify throughput constant by ADDING work to
--     a tick that already cannot finish its temp build. It was aimed at the wrong leg.
--
-- AND THE CHANGE HAS A MEASURED COST, which is what makes leaving it in place wrong rather than
-- merely useless: ts_listings ingest ran 23.6 rows/min in the 2 h before the change, 3.7/min for
-- the first 80 minutes after, and 18.5/min once the estate calmed -- still ~22 % under baseline.
--
-- ⚠ AND THE PREMISE ITSELF WAS OVERSTATED. The 09-18 filing said "zero output". Measured after
--    the fact, ts_listings took 2,837 rows in the 2 h before the change: DEGRADED (16-32 rows per
--    10 min after ~22:05 PT), not silent. The output cliff also PRECEDED the change by ~35 min.
--    ⭐ "Compare against the measured state, not the designed one" was the right instinct on
--    09-18, but the measured state I compared against was itself wrong -- I read a stale
--    max(ingested_at) as zero throughput instead of counting rows in a window.
--    A FRESHNESS STAMP IS NOT A RATE.
--
-- 👉 THE REAL FIX, recorded and NOT taken here: make _cl_want / _tsl_want cheaper -- a watermark
--    or incremental build, or a supporting index on the DISTINCT ON keys. That is a query change
--    on a lane another session owns (R108 neighbourhood), and it needs a cost measurement first.
--
-- ⚠ CHANGE POINT 2026-09-19 04:50 PT. jobid 466 now has TWO change points 6 h apart (22:40 PT
--    09-18 and this one). Any rate spanning either is pooled across a change.
--
-- REVERT OF THIS REVERT: select cron.alter_job(466, schedule => '*/6 * * * *');

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
    RAISE EXCEPTION 'jobid 466 is not rpc-ts-listings-atlas-sync - refusing to act on a job I cannot identify';
  END IF;

  IF v_before = '*/2 * * * *' THEN
    RAISE NOTICE 'lane already back on */2 - no change';
    RETURN;
  END IF;

  IF v_before <> '*/6 * * * *' THEN
    RAISE EXCEPTION 'lane is not on the schedule this reverts (found %) - re-derive before acting',
      v_before;
  END IF;

  PERFORM cron.alter_job(466, schedule => '*/2 * * * *');

  SELECT schedule, command, active INTO v_after, v_cmd, v_active FROM cron.job WHERE jobid = 466;

  IF v_after <> '*/2 * * * *' THEN
    RAISE EXCEPTION 'revert did not take (found %)', v_after;
  END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'lane came out INACTIVE - this migration restores a cadence, it does not stop it';
  END IF;
  IF v_cmd NOT LIKE '%atlas_listing_verify_tick%' THEN
    RAISE EXCEPTION 'lane command changed (%) - this migration changes WHEN, never WHAT', v_cmd;
  END IF;

  RAISE NOTICE 'ts-listings lane reverted % -> %, still active, command unchanged', v_before, v_after;
END
$mig$;
