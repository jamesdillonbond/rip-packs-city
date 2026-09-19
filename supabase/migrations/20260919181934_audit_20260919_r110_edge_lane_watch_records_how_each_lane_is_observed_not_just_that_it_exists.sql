-- audit_20260919_r110_edge_lane_watch_records_how_each_lane_is_observed
--
-- First run of `check_edge_lane_observability()` reported `unregistered_count: 7`
-- - correct by its own rule, and useless as a signal. Those seven edge-function
-- jobs DO write `pipeline_runs` rows, so the sentinel's existing pipeline arms
-- already cover them; flagging them alongside a genuinely blind lane buries the
-- one that matters.
--
-- ⭐ The fix is NOT to drop them from the ban - it is to make the registry record
-- HOW a lane is observed, so "covered elsewhere" is an explicit, reviewable
-- claim rather than an omission. The ban at zero survives: a lane absent from
-- the registry is still reported, and a lane claiming `pipeline_runs` coverage
-- NAMES the pipeline it claims, so the claim can be checked.
--
-- ⚠ `observed_via = 'pipeline_runs'` is a CLAIM ABOUT ANOTHER INSTRUMENT, which
-- CLAUDE.md warns is itself a thing to verify ("an exclusion justified by
-- ANOTHER instrument is a claim about it - check that one can SEE the
-- property"). Each such row stores `pipeline_name`, and the check VERIFIES that
-- pipeline has written a row inside pipeline_runs' ~73 h retention. A lane whose
-- claimed coverage has gone silent is reported as stale.
--
-- ✅ VERIFIED 2026-09-19 after populating all 12 lanes: inspected 12,
-- unregistered 0, stale 0, fresh 10, unchecked 2 (both deliberate and named).
-- ⭐ MUTATION-TESTED BOTH BRANCHES: deactivating one registry row surfaced that
-- lane in `unregistered` (count 1, correct jobname); setting an impossible
-- `max_age_hours` surfaced it in `stale` with age_hours 3.0. Both restored.
--
-- REVERT:
--   DROP FUNCTION public.check_edge_lane_observability();
--   DROP TABLE public.edge_lane_watch;

ALTER TABLE public.edge_lane_watch
  ADD COLUMN IF NOT EXISTS observed_via  text NOT NULL DEFAULT 'outcome_freshness',
  ADD COLUMN IF NOT EXISTS pipeline_name text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edge_lane_watch_observed_via_ck') THEN
    ALTER TABLE public.edge_lane_watch
      ADD CONSTRAINT edge_lane_watch_observed_via_ck
      CHECK (observed_via IN ('outcome_freshness','pipeline_runs','none'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edge_lane_watch_pipeline_name_ck') THEN
    -- A pipeline_runs claim must NAME the pipeline, or it cannot be checked.
    ALTER TABLE public.edge_lane_watch
      ADD CONSTRAINT edge_lane_watch_pipeline_name_ck
      CHECK (observed_via <> 'pipeline_runs' OR pipeline_name IS NOT NULL);
  END IF;
END $$;

COMMENT ON COLUMN public.edge_lane_watch.observed_via IS
  'outcome_freshness = this row carries a table/column/age bound. pipeline_runs '
  '= covered by the sentinel pipeline arms under `pipeline_name`, which the '
  'check VERIFIES is still writing. none = nothing watches it; `note` must say why.';

CREATE OR REPLACE FUNCTION public.check_edge_lane_observability()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '20s'
AS $function$
DECLARE
  v_inspected    int := 0;
  v_unregistered jsonb := '[]'::jsonb;
  v_stale        jsonb := '[]'::jsonb;
  v_unchecked    jsonb := '[]'::jsonb;
  v_ok           int := 0;
  r              record;
  v_newest       timestamptz;
  v_age          numeric;
  v_last_run     timestamptz;
BEGIN
  SELECT count(*) INTO v_inspected
  FROM cron.job j
  WHERE j.active AND j.command ~ '/functions/v1/';

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'jobid', j.jobid, 'jobname', j.jobname, 'schedule', j.schedule)), '[]'::jsonb)
    INTO v_unregistered
  FROM cron.job j
  WHERE j.active
    AND j.command ~ '/functions/v1/'
    AND NOT EXISTS (
      SELECT 1 FROM public.edge_lane_watch w
      WHERE w.jobname = j.jobname AND w.is_active);

  FOR r IN
    SELECT w.* FROM public.edge_lane_watch w
    JOIN cron.job j ON j.jobname = w.jobname AND j.active
    WHERE w.is_active
    ORDER BY w.jobname
  LOOP
    IF r.observed_via = 'none' THEN
      v_unchecked := v_unchecked || jsonb_build_object(
        'jobname', r.jobname, 'note', r.note, 'severity', r.severity);
      CONTINUE;
    END IF;

    IF r.observed_via = 'pipeline_runs' THEN
      -- Verify the claimed coverage is ALIVE, not just asserted.
      SELECT max(pr.started_at) INTO v_last_run
      FROM public.pipeline_runs pr WHERE pr.pipeline = r.pipeline_name;

      IF v_last_run IS NULL THEN
        v_stale := v_stale || jsonb_build_object(
          'jobname', r.jobname, 'outcome', 'pipeline_runs:' || r.pipeline_name,
          'age_hours', NULL, 'severity', r.severity,
          'detail', 'claimed pipeline_runs coverage has written NO row inside ~73h retention - the coverage this row claims does not exist');
      ELSE
        v_ok := v_ok + 1;
      END IF;
      CONTINUE;
    END IF;

    EXECUTE format('SELECT max(%I) FROM public.%I', r.outcome_column, r.outcome_table)
      INTO v_newest;

    IF v_newest IS NULL THEN
      v_stale := v_stale || jsonb_build_object(
        'jobname', r.jobname, 'outcome', r.outcome_table || '.' || r.outcome_column,
        'age_hours', NULL, 'max_age_hours', r.max_age_hours, 'severity', r.severity,
        'detail', 'outcome column is entirely NULL - unmeasured, not fresh');
      CONTINUE;
    END IF;

    v_age := round((extract(epoch FROM (now() - v_newest)) / 3600)::numeric, 1);
    IF v_age > r.max_age_hours THEN
      v_stale := v_stale || jsonb_build_object(
        'jobname', r.jobname, 'outcome', r.outcome_table || '.' || r.outcome_column,
        'age_hours', v_age, 'max_age_hours', r.max_age_hours, 'severity', r.severity,
        'note', r.note);
    ELSE
      v_ok := v_ok + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'inspected',          v_inspected,
    'unregistered_count', jsonb_array_length(v_unregistered),
    'unregistered',       v_unregistered,
    'stale_count',        jsonb_array_length(v_stale),
    'stale',              v_stale,
    'unchecked_count',    jsonb_array_length(v_unchecked),
    'unchecked',          v_unchecked,
    'fresh_count',        v_ok,
    'checked_at',         now()
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.check_edge_lane_observability() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.check_edge_lane_observability() TO postgres, service_role;
