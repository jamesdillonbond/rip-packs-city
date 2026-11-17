-- audit_20261011_pinnacle_pull_chain_cadence_baseline_bridge
--
-- 2026-10-11 ~8:20 AM PT (Claude Code; sentinel WARN "Cadence Collapse: pinnacle-pull-chain at 10%
-- of baseline (144/day vs 1440)").
--
-- WHY IT FIRES. 20261009195532 (10-09 ~12:55 PM PT) gated jobid 645 so the lane runs only when
-- pinnacle_pull_chain_pins has pending/in-flight work, else once every 10 minutes: the lane had
-- written 0 rows for days ("finished work"). pipeline_runs per hour went 60 -> 6 at 10-09 20:00Z
-- and has held at exactly 6 since, every run ok. The arm compares a 12 h window against a 14 d
-- baseline that still holds the pre-gate every-minute rate. A cadence CHANGED ON PURPOSE reads as
-- a cadence COLLAPSE until the baseline rolls past it (ratio crosses 0.40 by itself ~10-21).
--
-- WHAT THIS DOES. A dated exemption that lapses on its own (review_by 2026-10-24, after the 14 d
-- baseline holds no pre-gate day). The lane stays watched by Pipeline Silence / Pipeline Success,
-- which read its own schedule, not a historical rate. Not a threshold change.
--
-- REVERT: DELETE FROM public.cadence_exempt_lanes WHERE pipeline_pattern = 'pinnacle-pull-chain';

INSERT INTO public.cadence_exempt_lanes (pipeline_pattern, reason, evidence, review_by)
VALUES (
  'pinnacle-pull-chain',
  'Cadence deliberately cut 10x on 2026-10-09 (20261009195532: run only on pending/in-flight work, else every 10 min). The 14 d baseline still holds the pre-gate every-minute rate, so the arm reads a planned change as a collapse. Bridge only: lapses when the baseline is clean.',
  'Measured 2026-10-11 ~8:15 AM PT: pipeline_runs per hour = 60 through 10-09 19:00Z, 6 every hour from 10-09 20:00Z to now, all ok, rows_written 0 throughout (finished work). jobid 645 command gates on pinnacle_pull_chain_pins status pending/in_flight OR minute % 10 = 0. Expected ratio recovery: 144 / (144 + k*1296/14) >= 0.40 once k <= 2 pre-gate days remain in the 14 d baseline, i.e. ~10-21.',
  DATE '2026-10-24'
)
ON CONFLICT (pipeline_pattern) DO UPDATE
  SET reason = EXCLUDED.reason, evidence = EXCLUDED.evidence, review_by = EXCLUDED.review_by;

DO $mig$
DECLARE v_runs int; v_ok int;
BEGIN
  -- the premise must hold at apply time: the lane is alive at its gated rate
  SELECT count(*), count(*) FILTER (WHERE ok) INTO v_runs, v_ok
    FROM public.pipeline_runs
   WHERE pipeline = 'pinnacle-pull-chain' AND started_at > now() - interval '6 hours';
  IF v_runs < 30 OR v_ok < v_runs THEN
    RAISE EXCEPTION 'premise false: pinnacle-pull-chain ran % (% ok) in 6 h, expected ~36 all ok', v_runs, v_ok;
  END IF;
END
$mig$;
