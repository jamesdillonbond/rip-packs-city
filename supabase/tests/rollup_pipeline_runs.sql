-- DB invariant: public.rollup_pipeline_runs — the writer behind
-- public.pipeline_runs_daily, on pg_cron `11 */6 * * *`.
--
-- WHY IT MATTERS. `pipeline_runs` retains ~73h (prune_pipeline_runs(3) at
-- `41 */6 * * *`). pipeline_runs_daily is the INDEFINITE archive, and it is the
-- only place pipeline history older than three days exists at all — CLAUDE.md
-- points every "did this pipeline regress?" question at it. So a bug here does
-- not corrupt a cache, it destroys the record.
--
-- The MONOTONE GUARD is the invariant to protect. The rollup re-aggregates the
-- last p_days UTC days on every run, and the OLDEST day in that window is being
-- concurrently half-deleted by the pruner. Without `WHERE EXCLUDED.runs >= d.runs`
-- a pass would overwrite a previously-complete day with a truncated count — and
-- the result still looks like a plausible number, so nothing downstream flags it.
-- That is silent destruction of the archive this table exists to preserve.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260806034500_audit_20260806_rollup_pipeline_runs_shape_defensive_extra.sql),
-- whose body was verified byte-identical to live prod via prosrc md5 on
-- 2026-08-15. __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- duration_ms is GENERATED in prod (finished_at - started_at). The rollup only
-- READS it, so a plain column is faithful for this test and keeps the fixture on
-- vanilla Postgres.
CREATE TABLE public.pipeline_runs (
  id              bigserial primary key,
  pipeline        text,
  started_at      timestamptz,
  finished_at     timestamptz,
  duration_ms     int,
  rows_found      bigint,
  rows_written    bigint,
  rows_skipped    bigint,
  ok              boolean,
  error           text,
  collection_slug text,
  extra           jsonb
);

CREATE TABLE public.pipeline_runs_daily (
  pipeline         text,
  day              date,
  runs             int,
  ok_count         int,
  fail_count       int,
  rows_found       bigint,
  rows_written     bigint,
  rows_skipped     bigint,
  duration_ms_avg  int,
  duration_ms_p95  int,
  duration_ms_max  int,
  first_run_at     timestamptz,
  last_run_at      timestamptz,
  collection_slugs text[],
  last_error       text,
  extra_key_counts jsonb,
  refreshed_at     timestamptz,
  PRIMARY KEY (pipeline, day)
);

-- >>> BEGIN verbatim rollup_pipeline_runs (byte-identical to the migration/prod) >>>
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
-- <<< END verbatim rollup_pipeline_runs <<<

-- Three runs of one pipeline today, one failing.
INSERT INTO public.pipeline_runs
  (pipeline, started_at, finished_at, duration_ms, rows_found, rows_written, rows_skipped, ok, error, collection_slug, extra)
VALUES
  ('alpha', now() - interval '3 hours', now() - interval '3 hours', 100, 10, 5, 1, true,  NULL,      'nba_top_shot', '{"a":1}'::jsonb),
  ('alpha', now() - interval '2 hours', now() - interval '2 hours', 200, 20, 6, 2, false, 'boom',    'nfl_all_day',  '{"a":1,"b":2}'::jsonb),
  ('alpha', now() - interval '1 hour',  now() - interval '1 hour',  300, 30, 7, 3, true,  NULL,      NULL,           '{"b":2}'::jsonb);

SELECT _assert_eq((public.rollup_pipeline_runs() ->> 'upserted'), '1',
  'one (pipeline, day) row is written');

SELECT _assert_eq((SELECT runs::text         FROM public.pipeline_runs_daily WHERE pipeline='alpha'), '3', 'runs counts every run');
SELECT _assert_eq((SELECT ok_count::text     FROM public.pipeline_runs_daily WHERE pipeline='alpha'), '2', 'ok_count counts the successes');
SELECT _assert_eq((SELECT fail_count::text   FROM public.pipeline_runs_daily WHERE pipeline='alpha'), '1', 'fail_count counts the failures');
SELECT _assert_eq((SELECT rows_written::text FROM public.pipeline_runs_daily WHERE pipeline='alpha'), '18', 'rows_written sums');
SELECT _assert_eq((SELECT last_error         FROM public.pipeline_runs_daily WHERE pipeline='alpha'), 'boom', 'last_error carries the most recent error text');
SELECT _assert_eq((SELECT duration_ms_max::text FROM public.pipeline_runs_daily WHERE pipeline='alpha'), '300', 'duration_ms_max is the max');

-- collection_slugs drops NULLs rather than storing a NULL element, which would
-- make `= ANY(collection_slugs)` behave unpredictably downstream.
SELECT _assert_eq(
  (SELECT array_length(collection_slugs,1)::text FROM public.pipeline_runs_daily WHERE pipeline='alpha'),
  '2', 'collection_slugs holds the two distinct non-NULL slugs');

-- extra_key_counts is a per-key frequency over the day's payloads. It is the
-- payload-SHAPE drift signal, so counting rows rather than keys would hide it.
SELECT _assert_eq(
  (SELECT extra_key_counts ->> 'a' FROM public.pipeline_runs_daily WHERE pipeline='alpha'),
  '2', 'extra_key_counts counts the runs carrying each key');
SELECT _assert_eq(
  (SELECT extra_key_counts ->> 'b' FROM public.pipeline_runs_daily WHERE pipeline='alpha'),
  '2', 'and does so per key, not per row');

-- ⚠ THE MONOTONE GUARD ─────────────────────────────────────────────────────
-- Simulate the pruner half-deleting today's oldest run, then re-roll. The stored
-- row must NOT regress from 3 runs to 2. This is the assertion that makes the
-- archive trustworthy, and its failure mode is a plausible smaller number.
DELETE FROM public.pipeline_runs WHERE pipeline='alpha' AND duration_ms = 100;
SELECT public.rollup_pipeline_runs();
SELECT _assert_eq((SELECT runs::text FROM public.pipeline_runs_daily WHERE pipeline='alpha'), '3',
  'a partially-pruned day NEVER overwrites the fuller stored row');
SELECT _assert_eq((SELECT rows_written::text FROM public.pipeline_runs_daily WHERE pipeline='alpha'), '18',
  'and none of the other aggregates regress either — the guard blocks the whole row');

-- A GROWING day still updates: the guard is `>=`, not "never update".
INSERT INTO public.pipeline_runs
  (pipeline, started_at, finished_at, duration_ms, rows_found, rows_written, rows_skipped, ok, error, collection_slug, extra)
VALUES
  ('alpha', now() - interval '30 minutes', now(), 400, 40, 8, 4, true, NULL, 'ufc_strike', '{"c":3}'::jsonb),
  ('alpha', now() - interval '20 minutes', now(), 500, 50, 9, 5, true, NULL, NULL,          '{"c":3}'::jsonb);
SELECT public.rollup_pipeline_runs();
SELECT _assert_eq((SELECT runs::text FROM public.pipeline_runs_daily WHERE pipeline='alpha'), '4',
  'a day that GREW is updated (2 surviving + 2 new)');

-- last_error is COALESCEd, so a later clean pass must not erase a recorded error.
-- Without that, an error is only visible for the ~73h the raw rows survive, i.e.
-- exactly as long as the archive was not needed.
DELETE FROM public.pipeline_runs WHERE error IS NOT NULL;
INSERT INTO public.pipeline_runs
  (pipeline, started_at, finished_at, duration_ms, rows_found, rows_written, rows_skipped, ok, error, collection_slug, extra)
VALUES
  ('alpha', now() - interval '10 minutes', now(), 600, 60, 10, 6, true, NULL, NULL, '{"c":3}'::jsonb),
  ('alpha', now() - interval '5 minutes',  now(), 700, 70, 11, 7, true, NULL, NULL, '{"c":3}'::jsonb);
SELECT public.rollup_pipeline_runs();
SELECT _assert_eq((SELECT last_error FROM public.pipeline_runs_daily WHERE pipeline='alpha'), 'boom',
  'a recorded last_error survives a later error-free pass');

-- ⚠ SHAPE-DEFENSIVE extra ──────────────────────────────────────────────────
-- jsonb_object_keys() ERRORS on a non-object. One such row would abort the
-- INSERT for EVERY pipeline in the window, not just its own — so this is a
-- blast-radius guard, not a tidiness one.
INSERT INTO public.pipeline_runs
  (pipeline, started_at, finished_at, duration_ms, rows_found, rows_written, rows_skipped, ok, error, collection_slug, extra)
VALUES
  ('beta', now() - interval '1 hour', now(), 10, 1, 1, 0, true, NULL, NULL, '"a bare string"'::jsonb),
  ('beta', now() - interval '2 hour', now(), 10, 1, 1, 0, true, NULL, NULL, '[1,2,3]'::jsonb),
  ('beta', now() - interval '3 hour', now(), 10, 1, 1, 0, true, NULL, NULL, '{"ok":1}'::jsonb);
SELECT public.rollup_pipeline_runs();
SELECT _assert_eq((SELECT runs::text FROM public.pipeline_runs_daily WHERE pipeline='beta'), '3',
  'a non-object `extra` does not abort the rollup');
SELECT _assert_eq((SELECT extra_key_counts ->> 'ok' FROM public.pipeline_runs_daily WHERE pipeline='beta'), '1',
  'the object rows still contribute their keys; the non-objects contribute none');
SELECT _assert(
  (SELECT runs FROM public.pipeline_runs_daily WHERE pipeline='alpha') IS NOT NULL,
  'and the OTHER pipelines in the same window are still written');

-- The rollup logs its own pipeline_runs row, so a silent week is detectable.
SELECT _assert(
  EXISTS (SELECT 1 FROM public.pipeline_runs WHERE pipeline='pipeline-runs-daily-rollup'),
  'the rollup records its own run');

-- A run with a NULL pipeline is skipped rather than becoming a NULL-keyed row
-- (the PK would reject it and abort the whole statement).
INSERT INTO public.pipeline_runs
  (pipeline, started_at, finished_at, duration_ms, ok, extra)
VALUES (NULL, now(), now(), 5, true, '{}'::jsonb);
SELECT public.rollup_pipeline_runs();
SELECT _assert(
  NOT EXISTS (SELECT 1 FROM public.pipeline_runs_daily WHERE pipeline IS NULL),
  'a NULL-pipeline run is excluded rather than aborting the rollup');

SELECT '✓ rollup_pipeline_runs invariants pass' AS result;
ROLLBACK;
