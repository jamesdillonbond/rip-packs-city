-- audit_20261111_pull_chain_and_pinnacle_opener_cadence_bridge
--
-- 2026-11-11 ~11:20 AM PT (Claude Code cloud; Sentinel WARN 11:04 AM PT, Trevor: "Work through these too").
--
-- CADENCE: 20261110203906 (11-10 ~12:40 PM PT) put the 10-02 idle gate on two pg_cron slots:
--   rpc-topshot-pull-chain-lane (job 635)  -> pipeline pack-pulls-chain-history   1,440 -> ~120/day
--   rpc-pinnacle-opener-lane               -> pipeline pinnacle-pack-openers       1,440 -> ~144/day
-- That migration owed a cadence_exempt_lanes bridge (docs/reference/cron-and-schedulers.md:
-- "A GATE that cuts a lane's run rate is a CADENCE CHANGE, and owes its bridge in the same
-- migration") and did not carry one, so Cadence Collapse read the planned change as a collapse
-- (ratios 0.083 / 0.100 at 11:04 AM PT).
--
-- review_by: the arm's baseline is the MEDIAN of runs/day over [today-17, today-3) — the live
-- payload today names 2026-10-25 .. 2026-11-08. The first full gated day is 11-11; the median
-- falls to the gated rate once >= 8 gated days are inside the window (11-11 .. 11-18), i.e. on
-- 11-22. Bridge lapses on 11-23 (same arithmetic as 20261019143928: clean 10-29, review_by 10-30).
-- Pipeline Silence (max_silent 60 min) keeps watching both lanes meanwhile.
--
-- REVERT:
--   DELETE FROM public.cadence_exempt_lanes
--    WHERE pipeline_pattern IN ('pack-pulls-chain-history', 'pinnacle-pack-openers');

DO $mig$
DECLARE v_pull_runs int; v_pull_ok int; v_open_runs int; v_open_ok int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE ok) INTO v_pull_runs, v_pull_ok
    FROM public.pipeline_runs
   WHERE pipeline = 'pack-pulls-chain-history' AND started_at > now() - interval '6 hours';
  SELECT count(*), count(*) FILTER (WHERE ok) INTO v_open_runs, v_open_ok
    FROM public.pipeline_runs
   WHERE pipeline = 'pinnacle-pack-openers' AND started_at > now() - interval '6 hours';
  -- gated rate: ~5/h and ~6/h; anything near the old 60/h means the gate is gone and no bridge is owed
  IF v_pull_runs NOT BETWEEN 20 AND 120 OR v_pull_ok < v_pull_runs THEN
    RAISE EXCEPTION 'premise false: pack-pulls-chain-history ran % (% ok) in 6 h, expected ~30 all ok', v_pull_runs, v_pull_ok;
  END IF;
  IF v_open_runs NOT BETWEEN 24 AND 120 OR v_open_ok < v_open_runs THEN
    RAISE EXCEPTION 'premise false: pinnacle-pack-openers ran % (% ok) in 6 h, expected ~36 all ok', v_open_runs, v_open_ok;
  END IF;
END
$mig$;

INSERT INTO public.cadence_exempt_lanes (pipeline_pattern, reason, evidence, review_by)
VALUES
(
  'pack-pulls-chain-history',
  'Cadence deliberately cut ~12x on 2026-11-10 (20261110203906: rpc-topshot-pull-chain-lane runs only at minute % 15 = 0, minute 7, or when work is pending/in flight). The 14 d baseline median still holds the pre-gate every-minute rate, so the arm reads a planned change as a collapse. Bridge only: lapses when the baseline is clean.',
  'Measured 2026-11-11 ~11:15 AM PT: 60 runs/h through 11-10 12:00 PM PT, 5/h from 1 PM PT on, all ok (0 fails in 30 h). Arm payload: baseline 1440/day over 2026-10-25..2026-11-08, observed 120/day, ratio 0.083. Median drops once >= 8 gated days (11-11+) are inside the window, i.e. from 11-22.',
  DATE '2026-11-23'
),
(
  'pinnacle-pack-openers',
  'Cadence deliberately cut 10x on 2026-11-10 (20261110203906: rpc-pinnacle-opener-lane runs only at minute % 10 = 0 or when a window/request is pending or in flight). The 14 d baseline median still holds the pre-gate every-minute rate, so the arm reads a planned change as a collapse. Bridge only: lapses when the baseline is clean.',
  'Measured 2026-11-11 ~11:15 AM PT: 60 runs/h through 11-10 12:00 PM PT, 6/h from 1 PM PT on, all ok (0 fails in 30 h). Arm payload: baseline 1440/day over 2026-10-25..2026-11-08, observed 144/day, ratio 0.100. Median drops once >= 8 gated days (11-11+) are inside the window, i.e. from 11-22.',
  DATE '2026-11-23'
)
ON CONFLICT (pipeline_pattern) DO UPDATE
  SET reason = EXCLUDED.reason, evidence = EXCLUDED.evidence, review_by = EXCLUDED.review_by;
