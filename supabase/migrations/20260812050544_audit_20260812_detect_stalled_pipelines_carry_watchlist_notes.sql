-- audit_20260812_detect_stalled_pipelines_carry_watchlist_notes
--
-- WHY: the 2026-08-11 D2 outage (ingest-allday-pack-opens 403 for 24h) was dismissed
-- five consecutive times as a "documented no-op-walk false positive". The instrument
-- was NOT at fault: detect_stalled_pipelines() fired correctly every time.
--
-- The disqualifying evidence ALREADY EXISTED, in pipeline_cadence_watchlist.notes.
-- Both relevant rows say so in plain language:
--   allday-pack-opens-backfill      -> "KEEP THIS ROW ACTIVE even after done:true ...
--                                       silence here still means the SCHEDULER stopped,
--                                       which is a real signal."
--   topshot-pack-opens-history-backfill -> same instruction, same wording.
-- So the label did not merely get misapplied across pipelines; it CONTRADICTED the
-- note on the very rows it was applied to.
--
-- Why it was invisible: this function returned only
--   {pipeline, severity, max_silent_minutes, silent_minutes, last_run}
-- The operator/monitor reading that payload at the moment of dismissal could not see
-- the instruction telling them not to dismiss it.
--
-- FIX (additive, one key): carry `notes` in the payload so the justification travels
-- WITH the alert. This is the "carry the predicate, not the conclusion" principle
-- applied at the layer where the dismissal actually happens.
--
-- NOT the fix, and deliberately not done here:
--   * Widening check_edge_fn_http_failures() 4xx -> 5xx. It catches one status code and
--     leaves the general pre-logging-failure class open.
--   * Adding a SQL predicate column to pipeline_alert_suppression. VERIFIED 2026-08-12:
--     detect_stalled_pipelines() does not read that table at all (it joins only
--     pipeline_cadence_watchlist + pipeline_runs). The suppression table gates the
--     silent_failure / resolving_editions / cursor_stalled arms of
--     get_pipeline_alerts_core(), which are keyed on UNDERSCORED cursor names, while
--     this arm is keyed on HYPHENATED pipeline names. Hardening that table would have
--     hardened a mechanism that was never in this dismissal path.
--
-- Everything else is byte-identical to the prior definition: sql / STABLE /
-- SECURITY DEFINER / search_path=public / statement_timeout=8s. CREATE OR REPLACE
-- preserves the existing ACL (postgres owner + service_role; anon/authenticated
-- have no EXECUTE) -- re-verified after apply, per the 2026-08-11 RENAME lesson.
--
-- Consumers are shape-safe (both read named keys, neither asserts an exact key set):
--   app/api/sentinel/route.ts     ~line 402  (builds detail from named fields)
--   app/api/smoke-test/route.ts   ~line 709  (filters on .pipeline only)
--
-- REVERT: re-run this file with the 'notes' line removed from jsonb_build_object.

CREATE OR REPLACE FUNCTION public.detect_stalled_pipelines()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'pipeline', w.pipeline,
           'severity', w.severity,
           'max_silent_minutes', w.max_silent_minutes,
           'silent_minutes', round((extract(epoch from (now()-lr.last_run))/60)::numeric, 0),
           'last_run', lr.last_run,
           'notes', w.notes
         ) ORDER BY (extract(epoch from (now()-lr.last_run))/60) DESC NULLS FIRST), '[]'::jsonb)
  FROM pipeline_cadence_watchlist w
  LEFT JOIN LATERAL (
    SELECT max(started_at) AS last_run FROM pipeline_runs pr WHERE pr.pipeline = w.pipeline
  ) lr ON true
  WHERE w.is_active
    AND (lr.last_run IS NULL OR (extract(epoch from (now()-lr.last_run))/60) > w.max_silent_minutes);
$function$;

COMMENT ON FUNCTION public.detect_stalled_pipelines() IS
  'Active pipeline_cadence_watchlist rows past max_silent_minutes. Returns jsonb array of '
  '{pipeline, severity, max_silent_minutes, silent_minutes, last_run, notes}. `notes` added '
  '2026-08-12: it carries the row''s own dismissal criteria (e.g. "KEEP THIS ROW ACTIVE ... '
  'silence here still means the SCHEDULER stopped"), so a reader cannot apply a '
  '"known false positive" label without seeing the text that disqualifies it. Do not drop it.';
