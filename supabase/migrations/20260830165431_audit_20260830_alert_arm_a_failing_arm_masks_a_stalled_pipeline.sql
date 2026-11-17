-- audit_20260830_alert_arm_a_failing_arm_masks_a_stalled_pipeline
--
-- WHY (measured, not inferred). BOTH silence detectors on this platform --
-- the cadence arm inside get_pipeline_alerts_core() and the standalone
-- detect_stalled_pipelines() -- compute silence as
--     max(started_at) over ALL pipeline_runs rows for that pipeline,
-- with NO ok filter and no reference to rows_written. So when a pipeline has TWO
-- callers and one of them keeps FAILING, that failing caller writes a row every
-- tick and those failure rows keep the silence clock fresh. The alarm designed to
-- catch a dead pipeline CANNOT FIRE while something else fails loudly on its behalf.
--
-- Concrete case that exposed it: topshot-active-listings-ingest is fed by a
-- residential Windows Task Scheduler arm (18/18 ok over 7d) AND a GitHub Actions
-- arm whose runner IP Atlas WAF-blocks (0/9, every row error='egress_blocked',
-- atlas_calls=0). The GHA failure row every ~3h means the 900-minute cadence alarm
-- would stay green even if the residential box -- the ONLY arm that actually feeds
-- the board -- went dark for days.
--
-- MEASURED 2026-08-30 09:4x PT. Watchlisted pipelines with rows inside their OWN
-- silence window but ZERO ok runs in that window:
--   ingest                        2 runs, 0 ok,  0 written -- 'Top Shot GraphQL failed with 530' (dead legacy host)
--   match-topshot-players         1 run,  0 ok,  0 written
--   wallet-username-resolver      2 runs, 0 ok,  0 written -- ALSO flagged by failure_rate => POSITIVE CONTROL
--   reconcile-saved-wallet-stats  3 runs, 0 ok, 19 WRITTEN -- productive => NEGATIVE CONTROL, must NOT fire
--
-- The negative control is the whole reason this arm is not just "ok_runs = 0".
-- reconcile-saved-wallet-stats logs ok=false every hour with
-- error='soft_deadline_reached_partial_sweep_committed' while writing 2-8 rows per
-- run. It is WORKING; ok=false is overloaded. An arm keyed only on ok would cry
-- wolf on it every hour and be muted within a week. So the predicate is
-- "no ok run AND no work done", which separates FAILING-AND-IDLE from
-- FAILING-BUT-PRODUCTIVE.
--
-- This is ADDITIVE: a new arm function, appended in the get_pipeline_alerts()
-- wrapper exactly the way check_edge_fn_http_failures() already is. No existing
-- arm changes behaviour, no watchlist row changes, no data is touched.
--
-- anon-exec: unchanged -- get_pipeline_alerts is PRE-EXISTING and this migration replaces
-- only its BODY, adding a third arm. Its ACL was re-verified against the live database
-- before this line was written: anon=false, authenticated=false, service_role=true,
-- postgres=true. CREATE OR REPLACE FUNCTION does NOT reset a function's ACL, so adding a
-- REVOKE here would not be the no-op it looks like -- it would be an unreviewed production
-- ACL change dressed as boilerplate, which is exactly what the guard's header warns about.
-- The NEW function created here, check_pipelines_running_but_not_succeeding, carries a real
-- three-role REVOKE below (PUBLIC, anon, authenticated), verified anon/authenticated false.
--
-- REVERT (restores the two-term wrapper and drops the arm):
--   CREATE OR REPLACE FUNCTION public.get_pipeline_alerts()
--    RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
--    SET search_path TO 'public' SET statement_timeout TO '45s'
--   AS $function$
--     SELECT coalesce(public.get_pipeline_alerts_core(), '[]'::jsonb)
--         || coalesce(public.check_edge_fn_http_failures(interval '2 hours'), '[]'::jsonb);
--   $function$;
--   DROP FUNCTION IF EXISTS public.check_pipelines_running_but_not_succeeding();

CREATE OR REPLACE FUNCTION public.check_pipelines_running_but_not_succeeding()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
  WITH active_suppressions AS (
    SELECT pipeline
      FROM public.pipeline_alert_suppression
     WHERE expires_at IS NULL OR expires_at > now()
  ),
  agg AS (
    SELECT w.pipeline,
           w.severity,
           w.max_silent_minutes,
           count(pr.*)                                      AS runs,
           count(pr.*) FILTER (WHERE pr.ok)                  AS ok_runs,
           coalesce(sum(coalesce(pr.rows_written, 0)), 0)    AS work_done,
           max(pr.started_at)                                AS last_run
      FROM public.pipeline_cadence_watchlist w
      JOIN public.pipeline_runs pr
        ON pr.pipeline = w.pipeline
       AND pr.started_at > now() - (w.max_silent_minutes * interval '1 minute')
     WHERE w.is_active
       AND w.pipeline NOT IN (SELECT pipeline FROM active_suppressions)
     GROUP BY w.pipeline, w.severity, w.max_silent_minutes
  )
  SELECT coalesce(
           jsonb_agg(
             jsonb_build_object(
               'severity', severity,
               'type',     'running_but_not_succeeding',
               'pipeline', pipeline,
               'detail',   runs || ' run(s) in the last ' || max_silent_minutes
                        || ' min, ZERO ok and ZERO rows written -- the pipeline is FIRING but doing no work. '
                        || 'The cadence arm and detect_stalled_pipelines() BOTH read max(started_at) over ALL '
                        || 'rows with no ok filter, so these failure rows keep their silence clocks green; '
                        || 'this arm is the only one that can see it. Last run '
                        || to_char(last_run AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || 'Z. '
                        || 'NOTE this arm stays deliberately SILENT when a failing pipeline is still WRITING '
                        || 'rows (e.g. a partial-sweep commit that logs ok=false), because that shape is '
                        || 'productive, not stalled -- so a pipeline missing here is not thereby healthy.'
             )
             ORDER BY pipeline
           ), '[]'::jsonb)
    FROM agg
   WHERE ok_runs = 0
     AND work_done = 0;
$fn$;

REVOKE EXECUTE ON FUNCTION public.check_pipelines_running_but_not_succeeding()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_pipelines_running_but_not_succeeding()
  TO service_role, postgres;

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
jsonb_array_elements(), never count(*), which reads 1 for zero, one and forty alerts alike.';

CREATE OR REPLACE FUNCTION public.get_pipeline_alerts()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
  SELECT coalesce(public.get_pipeline_alerts_core(), '[]'::jsonb)
      || coalesce(public.check_edge_fn_http_failures(interval '2 hours'), '[]'::jsonb)
      || coalesce(public.check_pipelines_running_but_not_succeeding(), '[]'::jsonb);
$function$;
