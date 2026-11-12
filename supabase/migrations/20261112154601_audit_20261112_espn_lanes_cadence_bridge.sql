-- audit_20261112_espn_lanes_cadence_bridge
--
-- 2026-11-12 ~7:45 AM PT (Claude Code cloud; sentinel WARN 7:04 AM PT, Trevor: "Can you work on these
-- sentinel issues?").
--
-- Cadence Collapse read espn-athlete-bio 10/day vs 77 baseline and espn-search-crosswalk 8/day vs 34.
-- Neither lane slowed down. Both are pg_cron ticks every 10 minutes (rpc-espn-athlete-bio
-- `2,12,…`, rpc-espn-search `6,16,…`), and both RETURN {idle:true} WITHOUT calling log_pipeline_run
-- when there is nothing to drain or dispatch (read from prosrc 11-12). So a logged run counts WORK,
-- not ticks, and the work is a launch backlog that has drained since both lanes shipped on 11-08
-- (20261108210431 / 20261108213822):
--   espn-athlete-bio      runs/day 24 → 17 → 10 → 5 (11-09..11-12 partial), items 228 → 46 → 14 → 10
--   espn-search-crosswalk runs/day 27 → 19 → 10 → 4,                         items 247 → 213 → 60 → 18
--   every logged run in pipeline_runs ok=true.
-- The arm's baseline (median runs/day over [today-17, today-3)) holds only launch days, so a
-- backlog draining reads as a collapse. It is fully post-launch-drain once today-17 >= ~11-12,
-- i.e. from 11-29 — so a DATED BRIDGE to 11-30, not a permanent exemption (the 20260919210201
-- retraction: a suppression must not outlive the day the reading corrects itself).
-- What still watches these lanes: Pipeline Silence (max-silent window) and pg_cron failures.
--
-- REVERT:
--   DELETE FROM public.cadence_exempt_lanes WHERE pipeline_pattern IN ('espn-athlete-bio', 'espn-search-crosswalk');

DO $mig$
DECLARE v_fail int; v_jobs int;
BEGIN
  -- premise: the lanes are healthy, not failing
  SELECT count(*) INTO v_fail FROM public.pipeline_runs
   WHERE pipeline IN ('espn-athlete-bio', 'espn-search-crosswalk')
     AND started_at > now() - interval '72 hours' AND ok IS NOT TRUE;
  IF v_fail > 0 THEN
    RAISE EXCEPTION 'premise false: % failed espn lane runs in 72h', v_fail;
  END IF;
  -- premise: both ticks are still scheduled and active (so the low count is not a stopped job)
  SELECT count(*) INTO v_jobs FROM cron.job
   WHERE active AND command IN ('select public.espn_athlete_bio_tick()', 'select public.espn_search_tick()');
  IF v_jobs <> 2 THEN
    RAISE EXCEPTION 'premise false: % of 2 espn ticks active', v_jobs;
  END IF;
END
$mig$;

INSERT INTO public.cadence_exempt_lanes (pipeline_pattern, reason, evidence, review_by) VALUES
  ('espn-athlete-bio',
   'Demand-driven: espn_athlete_bio_tick runs every 10 min but logs a run ONLY when it drains or dispatches something (returns {idle:true} unlogged otherwise). Logged runs track the launch backlog (lane shipped 2026-11-08), which has drained; the 14 d baseline holds only launch days. Bridge only: lapses when the baseline is post-drain.',
   'Measured 2026-11-12 ~7:40 AM PT: runs/day 24/17/10/5 (11-09..11-12 partial), items found 228/46/14/10, every run ok. Arm payload: baseline 77/day, observed 10/day, ratio 0.13. Baseline window [today-17, today-3) is fully post-drain from 11-29.',
   '2026-11-30'),
  ('espn-search-crosswalk',
   'Demand-driven: espn_search_tick runs every 10 min but logs a run ONLY when it drains or dispatches something (returns {idle:true} unlogged otherwise). Logged runs track the launch backlog (lane shipped 2026-11-08), which has drained; the 14 d baseline holds only launch days. Bridge only: lapses when the baseline is post-drain.',
   'Measured 2026-11-12 ~7:40 AM PT: runs/day 27/19/10/4 (11-09..11-12 partial), items found 247/213/60/18, every run ok. Arm payload: baseline 34/day, observed 8/day, ratio 0.24. Baseline window [today-17, today-3) is fully post-drain from 11-29.',
   '2026-11-30')
ON CONFLICT DO NOTHING;
