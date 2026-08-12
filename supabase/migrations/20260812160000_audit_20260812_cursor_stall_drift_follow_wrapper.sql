-- audit_20260812_cursor_stall_drift_follow_wrapper
--
-- check_cursor_stall_threshold_drift() has been reporting drift on EVERY run
-- since 2026-08-11, hard-failing /api/smoke-test each time — and the invariant
-- it guards was intact the whole time.
--
-- What happened: the 08-11 edge-fn-403 work RENAMEd public.get_pipeline_alerts()
-- to public.get_pipeline_alerts_core() and gave its name to a thin wrapper that
-- composes core + check_edge_fn_http_failures(). This check hardcodes
--
--     pg_get_functiondef('public.get_pipeline_alerts()'::regprocedure)
--
-- so from that moment it has been inspecting the 155-char WRAPPER, which of
-- course does not mention cursor_stall_threshold() — while the 11,383-char core
-- still calls it, exactly as required. Measured 2026-08-12:
--   get_pipeline_alerts       155 chars, calls threshold fn = false  (wrapper)
--   get_pipeline_alerts_core  11,383 chars, calls threshold fn = TRUE (real arm)
--
-- Why this is worth a migration rather than a note. A check that fires on every
-- run has stopped being a check: if someone genuinely re-inlined the literal
-- tomorrow — the 2h-vs-6h blind window this guard exists to prevent — the alarm
-- would be indistinguishable from the one already showing. Same alert-fatigue
-- class this repo has recorded twice (ufc_fmv_stale_hours permanently red; the
-- 08-11 outage dismissed five times behind a stale annotation).
--
-- The fix does NOT simply re-point the name at _core, which would break again on
-- the next rename. It follows ONE hop: if the entry-point function does not call
-- the threshold fn itself, any public function it calls is inspected before drift
-- is declared. Splitting an arm behind a wrapper is a normal refactor and must not
-- read as drift; genuinely re-inlining the literal still does, because then
-- neither the entry point nor its callees mention the shared function.
--
-- REVERT: re-apply supabase/migrations/20260729032801_audit_20260729_check_cursor_stall_threshold_drift.sql
--         (restores the hardcoded single-function check).

CREATE OR REPLACE FUNCTION public.check_cursor_stall_threshold_drift()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_out        jsonb := '[]'::jsonb;
  v_viewdef    text;
  v_fndef      text;
  v_interval   interval;
  v_callee     oid;
  v_delegated  boolean := false;
BEGIN
  -- 0. The single source of truth must exist and be a sane positive interval.
  BEGIN
    v_interval := public.cursor_stall_threshold();
  EXCEPTION WHEN undefined_function THEN
    RETURN jsonb_build_array(jsonb_build_object(
      'kind', 'threshold_function_missing',
      'object_name', 'public.cursor_stall_threshold()',
      'detail', 'The canonical cursor-stall threshold function no longer exists; the view and the alert arm can no longer share a value.'
    ));
  END;

  IF v_interval IS NULL OR v_interval <= interval '0' THEN
    v_out := v_out || jsonb_build_object(
      'kind', 'threshold_not_positive',
      'object_name', 'public.cursor_stall_threshold()',
      'detail', 'Threshold is ' || COALESCE(v_interval::text, 'NULL') || '; must be a positive interval.'
    );
  END IF;

  -- 1. The classifier (view) must derive its cursor_stalled arm from the shared fn.
  v_viewdef := pg_get_viewdef('public.silent_indexer_failures'::regclass, true);
  IF v_viewdef NOT ILIKE '%cursor_stall_threshold()%' THEN
    v_out := v_out || jsonb_build_object(
      'kind', 'inlined_threshold',
      'object_name', 'public.silent_indexer_failures',
      'detail', 'The cursor_stalled status arm no longer calls public.cursor_stall_threshold(). '
             || 'If it has been re-inlined at a value below the alert arm, a stalled indexer is '
             || 'classified cursor_stalled — which matches NO alert arm — while the alert clock '
             || 'has not yet fired, leaving it invisible to every alert branch.'
    );
  END IF;

  -- 2. The alert arm must derive from the same shared fn — directly, or through a
  --    thin wrapper. get_pipeline_alerts() is the ENTRY POINT (what /api/check-alerts
  --    calls); the arm itself may legitimately live one call deeper.
  v_fndef := pg_get_functiondef('public.get_pipeline_alerts()'::regprocedure);

  IF v_fndef NOT ILIKE '%cursor_stall_threshold()%' THEN
    -- Follow ONE hop into any public function the entry point calls. The name
    -- filter needs `proname(` (not a bare substring) so `get_pipeline_alerts_core(`
    -- is not also credited to `get_pipeline_alerts`, and the length floor keeps a
    -- short-named unrelated function from matching incidental text. prokind='f'
    -- because pg_get_functiondef() errors on aggregates and window functions.
    FOR v_callee IN
      SELECT p.oid
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.prokind = 'f'
         AND p.oid <> 'public.get_pipeline_alerts()'::regprocedure
         AND length(p.proname) >= 8
         AND v_fndef ILIKE '%' || p.proname || '(%'
    LOOP
      IF pg_get_functiondef(v_callee) ILIKE '%cursor_stall_threshold()%' THEN
        v_delegated := true;
        EXIT;
      END IF;
    END LOOP;

    IF NOT v_delegated THEN
      v_out := v_out || jsonb_build_object(
        'kind', 'inlined_threshold',
        'object_name', 'public.get_pipeline_alerts()',
        'detail', 'The cursor_stalled alert arm no longer calls public.cursor_stall_threshold() — '
               || 'neither in get_pipeline_alerts() itself nor in any public function it calls. '
               || 'It can now drift away from the classifier threshold in silent_indexer_failures.'
      );
    END IF;
  END IF;

  RETURN v_out;
END;
$fn$;

COMMENT ON FUNCTION public.check_cursor_stall_threshold_drift() IS
  'Regression guard for audit_20260729_unify_cursor_stall_threshold: asserts that '
  'silent_indexer_failures and the get_pipeline_alerts() cursor_stalled arm both '
  'derive from public.cursor_stall_threshold(). The alert arm is resolved through '
  'ONE hop so a thin wrapper (the 2026-08-11 get_pipeline_alerts_core split) does '
  'not read as drift. Returns [] when clean; wired into /api/smoke-test as a HARD probe.';

REVOKE EXECUTE ON FUNCTION public.check_cursor_stall_threshold_drift() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_cursor_stall_threshold_drift() TO postgres, service_role;
