-- audit_20260806_rollup_pipeline_runs_shape_defensive_extra
--
-- ONE malformed row took down the ONLY indefinite pipeline history.
--
-- rollup_pipeline_runs() builds extra_key_counts with
--     jsonb_object_keys(COALESCE(e, '{}'::jsonb))
-- which guards NULL but NOT a non-OBJECT jsonb. `jsonb_object_keys` hard-errors on
-- a JSON array ("cannot call jsonb_object_keys on an array"), and because the whole
-- rollup is a single INSERT ... SELECT, that one row aborts the aggregate for EVERY
-- pipeline on EVERY day in the window.
--
-- Measured live 2026-08-05: of 42,010 pipeline_runs rows, extra shape is
--   object 42,003 | NULL 6 | array 1
-- The single array row is pipeline='diag-step6-cohort' (a 2026-08-05 16:40Z one-shot
-- diagnostic). pg_cron jobid 233 (rpc-pipeline-runs-daily-rollup, '11 */6 * * *')
-- had failed 2 consecutive ticks (18:11Z, 00:11Z) and pipeline_runs_daily held
-- 0 rows for 2026-08-06.
--
-- ⚠ WHY THIS MATTERS MORE THAN IT LOOKS: pipeline_runs itself retains only ~73h
-- (prune_pipeline_runs(3)), so pipeline_runs_daily is the ONLY durable record and
-- "cannot be backfilled earlier". Every failed tick was permanently losing history
-- from the exact archive multiple sessions rely on for >73h defect archaeology.
-- It would have PARTLY self-healed when the offending row aged out (~2026-08-08),
-- but the days lost until then are unrecoverable and the defect RECURS on any
-- future non-object `extra` — a single diagnostic write must never be able to
-- blind the observability archive.
--
-- Fix: treat any non-object `extra` as no-keys, so array/scalar shapes contribute
-- nothing to extra_key_counts instead of aborting the statement. Purely defensive;
-- the object path (42,003 of 42,010 rows) is byte-identical in behaviour.
-- Everything else — the MONOTONE GUARD, the generated-duration_ms note, the
-- self-logging pipeline_runs write — is unchanged from
-- audit_20260801_rollup_pipeline_runs_fix_generated_duration.
--
-- REVERT: restore the single expression
--     jsonb_object_keys(COALESCE(e, '{}'::jsonb))
-- in the extra_key_counts subquery.

CREATE OR REPLACE FUNCTION public.rollup_pipeline_runs(p_days integer DEFAULT 4)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_cutoff date;
  v_upserted bigint;
  v_started timestamptz := clock_timestamp();
BEGIN
  -- Re-aggregate the last p_days UTC days every run. Idempotent + self-healing:
  -- a missed run recovers on the next pass, so long as p_days > raw retention.
  v_cutoff := (CURRENT_DATE - GREATEST(p_days - 1, 0));

  INSERT INTO public.pipeline_runs_daily AS d (
    pipeline, day, runs, ok_count, fail_count,
    rows_found, rows_written, rows_skipped,
    duration_ms_avg, duration_ms_p95, duration_ms_max,
    first_run_at, last_run_at, collection_slugs, last_error,
    extra_key_counts, refreshed_at
  )
  SELECT
    r.pipeline,
    (r.started_at AT TIME ZONE 'UTC')::date            AS day,
    count(*)::int                                       AS runs,
    count(*) FILTER (WHERE r.ok)::int                   AS ok_count,
    count(*) FILTER (WHERE NOT r.ok)::int               AS fail_count,
    sum(r.rows_found)::bigint,
    sum(r.rows_written)::bigint,
    sum(r.rows_skipped)::bigint,
    avg(r.duration_ms)::int,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY r.duration_ms)::int,
    max(r.duration_ms)::int,
    min(r.started_at),
    max(r.started_at),
    (SELECT array_agg(DISTINCT s) FROM unnest(array_agg(r.collection_slug)) s WHERE s IS NOT NULL),
    (array_agg(r.error ORDER BY r.started_at DESC) FILTER (WHERE r.error IS NOT NULL))[1],
    (
      SELECT jsonb_object_agg(k, n)
      FROM (
        SELECT k, count(*) AS n
        -- SHAPE-DEFENSIVE: jsonb_object_keys ERRORS on a non-object jsonb, and one
        -- such row would abort this INSERT for every pipeline in the window.
        FROM unnest(array_agg(r.extra)) e,
             LATERAL jsonb_object_keys(
               CASE WHEN jsonb_typeof(e) = 'object' THEN e ELSE '{}'::jsonb END
             ) k
        GROUP BY k
      ) ek
    ),
    now()
  FROM public.pipeline_runs r
  WHERE r.started_at >= v_cutoff::timestamptz
    AND r.pipeline IS NOT NULL
  GROUP BY r.pipeline, (r.started_at AT TIME ZONE 'UTC')::date
  ON CONFLICT (pipeline, day) DO UPDATE SET
    runs             = EXCLUDED.runs,
    ok_count         = EXCLUDED.ok_count,
    fail_count       = EXCLUDED.fail_count,
    rows_found       = EXCLUDED.rows_found,
    rows_written     = EXCLUDED.rows_written,
    rows_skipped     = EXCLUDED.rows_skipped,
    duration_ms_avg  = EXCLUDED.duration_ms_avg,
    duration_ms_p95  = EXCLUDED.duration_ms_p95,
    duration_ms_max  = EXCLUDED.duration_ms_max,
    first_run_at     = LEAST(d.first_run_at, EXCLUDED.first_run_at),
    last_run_at      = GREATEST(d.last_run_at, EXCLUDED.last_run_at),
    collection_slugs = EXCLUDED.collection_slugs,
    last_error       = COALESCE(EXCLUDED.last_error, d.last_error),
    extra_key_counts = EXCLUDED.extra_key_counts,
    refreshed_at     = now()
  -- MONOTONE GUARD (load-bearing): the oldest day in the window is PARTIALLY PRUNED
  -- by prune_pipeline_runs(3). Without this, re-aggregating a half-deleted day would
  -- overwrite a previously-complete row with a truncated count -- silently corrupting
  -- the very archive this table exists to preserve. Never regress a fuller row.
  WHERE EXCLUDED.runs >= d.runs;

  GET DIAGNOSTICS v_upserted = ROW_COUNT;

  -- NOTE: duration_ms is GENERATED on pipeline_runs -- never list it here.
  INSERT INTO public.pipeline_runs (pipeline, started_at, finished_at, rows_written, ok, extra)
  VALUES (
    'pipeline-runs-daily-rollup', v_started, clock_timestamp(),
    v_upserted::int, true,
    jsonb_build_object('days', p_days, 'cutoff', v_cutoff, 'upserted', v_upserted)
  );

  RETURN jsonb_build_object(
    'upserted', v_upserted,
    'days', p_days,
    'cutoff', v_cutoff,
    'total_rows', (SELECT count(*) FROM public.pipeline_runs_daily)
  );
END;
$function$;
