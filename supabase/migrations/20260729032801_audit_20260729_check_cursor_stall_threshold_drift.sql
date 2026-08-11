-- Regression guard for audit_20260729_unify_cursor_stall_threshold.
--
-- The 2h-vs-6h blind window existed because ONE conceptual threshold was written
-- as two independent literals in two objects. Both now call
-- public.cursor_stall_threshold(). This check asserts that they still do, so a
-- future CREATE OR REPLACE that re-inlines a literal (exactly how this class of
-- bug arises here — rebuilding a view/fn from an older copy) reddens CI instead
-- of silently re-opening the window.
--
-- Returns [] when clean. Wired into /api/smoke-test as a HARD probe.
-- REVERT: DROP FUNCTION public.check_cursor_stall_threshold_drift();

CREATE OR REPLACE FUNCTION public.check_cursor_stall_threshold_drift()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_out      jsonb := '[]'::jsonb;
  v_viewdef  text;
  v_fndef    text;
  v_interval interval;
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

  -- 2. The alert arm must derive from the same shared fn.
  v_fndef := pg_get_functiondef('public.get_pipeline_alerts()'::regprocedure);
  IF v_fndef NOT ILIKE '%cursor_stall_threshold()%' THEN
    v_out := v_out || jsonb_build_object(
      'kind', 'inlined_threshold',
      'object_name', 'public.get_pipeline_alerts()',
      'detail', 'The cursor_stalled alert arm no longer calls public.cursor_stall_threshold(); '
             || 'it can now drift away from the classifier threshold in silent_indexer_failures.'
    );
  END IF;

  RETURN v_out;
END;
$fn$;

COMMENT ON FUNCTION public.check_cursor_stall_threshold_drift() IS
  'Asserts the cursor-stall threshold is still expressed ONCE (public.cursor_stall_threshold) '
  'and shared by both silent_indexer_failures and get_pipeline_alerts. Returns [] when clean. '
  'Guards the 2026-07-29 fix for the 2h..6h window in which a stalled indexer matched no alert arm.';

REVOKE EXECUTE ON FUNCTION public.check_cursor_stall_threshold_drift() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_cursor_stall_threshold_drift() TO postgres, service_role;