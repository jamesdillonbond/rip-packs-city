-- audit_20261011_pinnacle_pull_chain_cadence_bridge_review_by_matches_the_real_baseline_window
--
-- 2026-10-11 ~8:25 AM PT (Claude Code). Correction to 20261011151215, same session.
--
-- That migration dated the bridge to a plain 14 d baseline. The arm's own output says otherwise:
-- window.exclude_days = 3, baseline_window = [today-17, today-3] (read today: 09-24 .. 10-08).
-- Pre-gate days (every-minute, through 10-09) therefore stay in the baseline until 10-26, and the
-- ratio clears 0.40 only once <= 2 of them remain (~10-25). review_by 10-24 would have lapsed
-- while the arm still read a planned change as a collapse. 10-28 = first day the baseline holds
-- no pre-gate day, plus one.
--
-- REVERT: UPDATE public.cadence_exempt_lanes SET review_by = DATE '2026-10-24'
--          WHERE pipeline_pattern = 'pinnacle-pull-chain';

UPDATE public.cadence_exempt_lanes
   SET review_by = DATE '2026-10-28',
       evidence = evidence || ' CORRECTED same day: the arm excludes the last 3 days, so the baseline is [today-17, today-3]; pre-gate days leave it on 10-27, hence review_by 2026-10-28 (was 10-24).'
 WHERE pipeline_pattern = 'pinnacle-pull-chain';

DO $mig$
BEGIN
  IF (SELECT review_by FROM public.cadence_exempt_lanes WHERE pipeline_pattern = 'pinnacle-pull-chain')
     IS DISTINCT FROM DATE '2026-10-28' THEN
    RAISE EXCEPTION 'review_by not updated';
  END IF;
  IF (public.check_pipeline_cadence_collapse()->'window'->>'exclude_days')::int <> 3 THEN
    RAISE EXCEPTION 'premise changed: exclude_days is no longer 3 — re-derive review_by';
  END IF;
END
$mig$;
