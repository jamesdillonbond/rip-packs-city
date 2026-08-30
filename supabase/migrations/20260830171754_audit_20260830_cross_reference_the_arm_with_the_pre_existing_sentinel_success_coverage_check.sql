-- audit_20260830_cross_reference_the_arm_with_the_pre_existing_sentinel_success_coverage_check
--
-- COMMENT-only. No signature change, no grants, no behaviour, no data, no ACL.
--
-- WHY. Within an hour of shipping check_pipelines_running_but_not_succeeding()
-- (20260830165431) I found the sentinel route ALREADY carries "Pipeline Success
-- Coverage" (app/api/sentinel/route.ts, shipped 2026-08-17), which reached the
-- SAME predicate independently -- same "zero successes AND zero rows written",
-- same negative control (reconcile-saved-wallet-stats), same reuse of
-- pipeline_alert_suppression. I built mine without finding it first. Recording
-- that in the function's own comment so the next reader does not repeat it a
-- third time, and so nobody is puzzled by two arms saying similar things.
--
-- They are NOT redundant. The difference is the WINDOW:
--   sentinel  = FIXED 24-48h over pipeline_runs_daily (the 6-hourly rollup, used
--               because pipeline_runs exceeds the PostgREST 1000-row cap from
--               outside the DB) -- lags up to 6h, and a pipeline that succeeded
--               30h ago but has failed every run since reads HEALTHY.
--   this arm  = each pipeline judged over ITS OWN max_silent_minutes against live
--               pipeline_runs from INSIDE the DB -- no cap, no rollup lag.
-- Measured 2026-08-30 17:1xZ: both fire on `ingest`; only this arm fires on
-- match-topshot-players (1 ok 30h ago) and wallet-username-resolver (6 ok
-- yesterday, 0 inside its 450-minute budget). The rollup was 5h stale at the time.
--
-- ⚠ Also records the consequence worth knowing: a pipeline BOTH arms catch emits
-- TWO alerts, and because they share pipeline_alert_suppression, one bounded
-- suppression silences both -- usually desirable, but a wider action than it looks.
--
-- REVERT (restores the comment as it stood after 20260830165431):
--   see that migration's COMMENT ON FUNCTION block and re-apply it verbatim.

COMMENT ON FUNCTION public.check_pipelines_running_but_not_succeeding() IS
'Alert arm added 2026-08-30. Fires when a watchlisted pipeline HAS run inside its own
max_silent_minutes window but produced ZERO ok runs AND ZERO rows_written in it.

Exists because both silence detectors (the cadence arm in get_pipeline_alerts_core and
detect_stalled_pipelines) measure max(started_at) with NO ok filter, so a second, permanently
failing caller writes a row every tick and holds their clocks green over a genuinely dead
pipeline. Found via topshot-active-listings-ingest, whose blocked GitHub Actions arm (0/9,
egress_blocked) would have masked its residential arm going dark.

The "AND work_done = 0" half is load-bearing, not defensive: reconcile-saved-wallet-stats logs
ok=false hourly (soft_deadline_reached_partial_sweep_committed) while writing 2-8 rows a run. It
is working, and an arm keyed only on ok would page on it every hour until muted. Keying on
"no success AND no work" separates FAILING-AND-IDLE from FAILING-BUT-PRODUCTIVE.

Returns ONE ROW holding a jsonb ARRAY -- read it with jsonb_array_length() or
jsonb_array_elements(), never count(*), which reads 1 for zero, one and forty alerts alike.

*** 2026-08-30, SAME DAY: THIS IS NOT THE FIRST ARM WITH THIS IDEA -- READ BOTH BEFORE ADDING A THIRD. ***
The sentinel route already carries "Pipeline Success Coverage" (app/api/sentinel/route.ts, shipped
2026-08-17 off apply-fmv-haircut + match-topshot-players failing 3+ days unnoticed). It reached the
SAME predicate independently, down to the same negative control (reconcile-saved-wallet-stats) and
the same reuse of pipeline_alert_suppression. I built this one without finding it first; recording
that here so the next reader does not have to.

They are NOT redundant, and the difference is the WINDOW, which is why both currently disagree:
  * Sentinel: a FIXED 24-48h window over pipeline_runs_daily -- the 6-hourly rollup, chosen because
    pipeline_runs exceeds PostgREST 1000-row cap from OUTSIDE the DB. Consequence: it lags up to 6h,
    and a pipeline that succeeded 30h ago but has failed every run since reads HEALTHY.
  * This arm: each pipeline is judged over ITS OWN max_silent_minutes, against live pipeline_runs
    from INSIDE the DB (no PostgREST cap, no rollup lag).
Measured at 2026-08-30 17:1xZ, both fire on `ingest`; only this arm fires on match-topshot-players
(1 ok 30h ago) and wallet-username-resolver (6 ok yesterday, 0 inside its 450-min budget).

CONSEQUENCE TO KNOW: a pipeline both arms catch produces TWO alerts. They share
pipeline_alert_suppression, so one bounded suppression silences both -- which is usually what you
want, but means suppressing here is a WIDER action than it looks.';
