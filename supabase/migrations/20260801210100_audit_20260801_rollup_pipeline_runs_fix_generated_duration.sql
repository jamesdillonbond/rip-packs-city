-- audit_20260801_rollup_pipeline_runs_fix_generated_duration
--
-- Live definition of the pipeline_runs daily-rollup writer.
-- Supersedes the first version applied in audit_20260801_pipeline_runs_daily_rollup,
-- which failed on every call: public.pipeline_runs.duration_ms is a GENERATED column
-- and cannot be supplied on INSERT (SQLSTATE 428C9). Reading it in the aggregation is
-- fine; only the self-log INSERT column list had to drop it.

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
        FROM unnest(array_agg(r.extra)) e, LATERAL jsonb_object_keys(COALESCE(e, '{}'::jsonb)) k
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

-- Default EXECUTE on a new function is granted to PUBLIC; revoke it or the
-- secdef-anon-exec-drift sentinel fires (and anon gains a write path).
REVOKE EXECUTE ON FUNCTION public.rollup_pipeline_runs(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rollup_pipeline_runs(integer) FROM anon, authenticated;

-- Schedule: :11 every 6h, i.e. 30 min AHEAD of rpc-prune-pipeline-runs (jobid 57,
-- '41 */6 * * *'), so the rollup always captures a day before the prune trims it.
-- p_days=4 > the 3-day raw retention, so a missed run self-heals on the next pass.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'rpc-pipeline-runs-daily-rollup',
      '11 */6 * * *',
      'SELECT public.rollup_pipeline_runs(4)'
    );
  END IF;
END
$do$;
