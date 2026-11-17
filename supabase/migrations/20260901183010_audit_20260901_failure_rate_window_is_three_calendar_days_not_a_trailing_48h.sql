-- audit_20260901_failure_rate_window_is_three_calendar_days_not_a_trailing_48h
--
-- WHAT: metadata only. Attaches a COMMENT to public.v_pipeline_failure_rates. No behaviour change,
--       no ACL change, no schema change. The view had NO comment before this migration (verified
--       2026-09-01 18:29Z: obj_description(...) IS NULL).
--
-- WHY:  the repo has repeatedly described this arm as a "trailing 2-day window" that "ages out",
--       and passes keep re-triaging the same alert because that description is wrong in a way that
--       matters. The predicate is `day >= CURRENT_DATE - 2` over pipeline_runs_daily -- THREE
--       calendar days (CURRENT_DATE-2, -1, and today), so it is up to 72 h wide immediately after
--       UTC midnight and shrinks toward ~48 h just before the next one. A failure therefore stays
--       counted for between 48 h and 72 h depending on the hour it happened, and it always leaves
--       the window at a UTC midnight -- never at "48 h after the failure".
--
-- MEASURED INSTANCE, this pass (fmv-backfill, read 2026-09-01 18:29:30Z, CURRENT_DATE 2026-09-01):
--       day 2026-08-30 runs 9 fails 5 | 2026-08-31 runs 4 fails 0 | 2026-09-01 runs 4 fails 0
--       => 5/17 = 29.4 %, exactly what get_pipeline_alerts() reports. Every failure is on 08-30 and
--       every one predates migration 20260831045517 (the sales_2020..2024 vacuum/analyze fix).
--       PREDICTION, falsifiable: with no new failure this alert disappears at 2026-09-02 00:00 UTC,
--       when CURRENT_DATE rolls to 2026-09-02 and the 08-30 row leaves the window.
--
-- GUARDED: RAISEs if the view no longer filters on CURRENT_DATE - 2, so the note cannot outlive the
--       predicate it describes.
--
-- REVERT: COMMENT ON VIEW public.v_pipeline_failure_rates IS NULL;
--
-- ⚠ SCOPE OF THE NO-PUSH BLOCKER: specific to THIS CLOUD SESSION (the git proxy answers
--   "not in this session's authorized repository set"). Trevor's machine and Claude Code push
--   normally via the PAT in remote.origin.pushurl. COMMIT THIS FILE AS USUAL.
--
-- ⓘ No `-- anon-exec:` line is required: this migration does not CREATE OR REPLACE any public
--   function. If CI disagrees, read the check-run for the current tip before attributing the red.

DO $$
DECLARE
  v_def  text;
  v_note text;
BEGIN
  SELECT pg_get_viewdef('public.v_pipeline_failure_rates'::regclass, true) INTO v_def;

  IF position('CURRENT_DATE - 2' IN v_def) = 0 THEN
    RAISE EXCEPTION
      'anchor not found: v_pipeline_failure_rates no longer filters on (day >= CURRENT_DATE - 2) (viewdef len=%). Refusing to attach a note that describes a window this view no longer uses.',
      length(v_def);
  END IF;

  v_note :=
    'FAILURE-RATE ALERT WINDOW -- READ THIS BEFORE RE-TRIAGING A failure_rate ALERT. '
    'The filter is `day >= CURRENT_DATE - 2` over pipeline_runs_daily, which is THREE CALENDAR DAYS '
    '(CURRENT_DATE-2, CURRENT_DATE-1, today) -- NOT a trailing 48 h. It is ~72 h wide just after UTC '
    'midnight and narrows toward ~48 h just before the next one, so a failure stays counted for '
    'between 48 h and 72 h and always leaves the window AT A UTC MIDNIGHT, never 48 h after the '
    'failure itself. Arming also requires sum(runs) >= 5 AND fail share > 0.25 over that window. '
    'CONSEQUENCE: an alert whose numerator is frozen while its denominator grows (e.g. 5/13 -> 5/15 '
    '-> 5/17) has NO new failures and is aging out -- do not "fix" it again; check whether failures '
    'CONTINUE past the fix before claiming you resolved one. '
    'MEASURED 2026-09-01 18:29Z (fmv-backfill): 08-30 runs 9 fails 5; 08-31 runs 4 fails 0; 09-01 '
    'runs 4 fails 0 => 5/17 = 29.4 %, all five failures on 08-30 and all predating migration '
    '20260831045517. Prediction recorded then: absent a new failure, that alert clears at '
    '2026-09-02 00:00 UTC. '
    'ⓘ pipeline_runs_daily is rolled up by pg_cron jobid 233 (`11 */6`), so TODAY''s row is only as '
    'fresh as the last rollup -- the denominator lags reality by up to 6 h. '
    'Note added by migration audit_20260901_failure_rate_window_is_three_calendar_days_not_a_trailing_48h. '
    'REVERT: COMMENT ON VIEW public.v_pipeline_failure_rates IS NULL; (there was no comment before).';

  EXECUTE format('COMMENT ON VIEW public.v_pipeline_failure_rates IS %L', v_note);
END $$;