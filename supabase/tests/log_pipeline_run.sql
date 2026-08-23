-- DB invariant: public.log_pipeline_run(text, timestamptz, ...) → bigint — the
-- canonical pipeline-observability writer, with 129 call sites (more than any
-- other RPC in the codebase). Every ingest, cron and backfill reports through
-- it, and detect_stalled_pipelines() / get_pipeline_alerts() / the sentinel /
-- pipeline_runs_daily all read what it writes.
--
-- Pins:
--   • The three row counters COALESCE to 0. Callers routinely pass NULL for a
--     counter they don't track; if that reached the column, every downstream
--     SUM() over pipeline_runs would go NULL and a broken pipeline would read
--     as healthy-but-empty — a silent failure in the layer whose whole job is
--     to make failure loud.
--   • finished_at is stamped by the FUNCTION, while started_at is the caller's
--     value. That pairing is what makes duration measurable; if finished_at were
--     also caller-supplied, an unset one would read as a zero-length run.
--   • 🚨 finished_at uses `clock_timestamp()`, NOT `now()`, and that ONE WORD is
--     the whole of `pipeline_runs.duration_ms`. `duration_ms` is GENERATED over
--     (finished_at - started_at) and GREATEST-clamped at 0. Callers pass
--     `p_started_at := clock_timestamp()` taken at their own entry — a real
--     wall-clock reading DURING the transaction — while `now()` is transaction
--     START, which is always EARLIER. Under `now()` the subtraction went negative
--     on every call, the clamp fired, and `duration_ms` was a structural hard 0
--     for TEN pipelines. Two of them were taking 37.8 s and 78.4 s while
--     reporting zero to every duration-ranked board and arm.
--     ⚠ THE OLD ASSERTION COULD NOT SEE ANY OF THAT. It called the function with
--     `now() - interval '5 seconds'`, so `finished_at > started_at` held under
--     BOTH bodies — the fixture back-dated the problem away. The pin below is
--     written the way production actually calls it, so it FAILS on `now()`.
--   • ok=false + error text round-trip intact (the alerting predicate).
--   • It RETURNS the new id (callers chain on it).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260823190648_audit_20260823_log_pipeline_run_finished_at_uses_clock_timestamp.sql),
-- pulled from live prod via pg_get_functiondef on 2026-08-23 (md5
-- 6dd327eea2dfb888e0340816dddc9fe8, verified against the DB's own md5 rather than
-- by eye); __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE pipeline_runs (
  id             bigserial PRIMARY KEY,
  pipeline       text,
  collection_slug text,
  started_at     timestamptz,
  finished_at    timestamptz,
  rows_found     integer,
  rows_written   integer,
  rows_skipped   integer,
  cursor_before  text,
  cursor_after   text,
  ok             boolean,
  error          text,
  extra          jsonb
);

-- >>> BEGIN verbatim log_pipeline_run (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamp with time zone, p_rows_found integer DEFAULT 0, p_rows_written integer DEFAULT 0, p_rows_skipped integer DEFAULT 0, p_ok boolean DEFAULT true, p_error text DEFAULT NULL::text, p_collection_slug text DEFAULT NULL::text, p_cursor_before text DEFAULT NULL::text, p_cursor_after text DEFAULT NULL::text, p_extra jsonb DEFAULT NULL::jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO public.pipeline_runs (
    pipeline, collection_slug, started_at, finished_at,
    rows_found, rows_written, rows_skipped,
    cursor_before, cursor_after, ok, error, extra
  ) VALUES (
    -- clock_timestamp(), NOT now(): now() is transaction start, which precedes
    -- the clock_timestamp() every caller passes as p_started_at, so duration_ms
    -- (GREATEST-clamped) was pinned at 0 for 10 pipelines.
    p_pipeline, p_collection_slug, p_started_at, clock_timestamp(),
    COALESCE(p_rows_found,0), COALESCE(p_rows_written,0), COALESCE(p_rows_skipped,0),
    p_cursor_before, p_cursor_after, p_ok, p_error, p_extra
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;
-- <<< END verbatim log_pipeline_run <<<

-- Happy path: returns an id and writes the row.
SELECT _assert(
  public.log_pipeline_run('test-pipeline', now() - interval '5 seconds', 10, 7, 3) IS NOT NULL,
  'returns the new row id'
);
SELECT _assert_eq((SELECT count(*)::text FROM pipeline_runs), '1', 'wrote exactly one run row');
SELECT _assert_eq((SELECT rows_found::text FROM pipeline_runs), '10', 'rows_found round-trips');
SELECT _assert_eq((SELECT rows_written::text FROM pipeline_runs), '7', 'rows_written round-trips');
SELECT _assert_eq((SELECT rows_skipped::text FROM pipeline_runs), '3', 'rows_skipped round-trips');
SELECT _assert_eq((SELECT ok::text FROM pipeline_runs), 'true', 'ok defaults to true');

-- finished_at is stamped by the function; started_at is the caller's.
-- ⚠ KEPT, BUT IT IS NOT THE PIN. The fixture back-dates started_at by 5 s, so
-- this holds under `now()` too. It is the clock-skew case below that discriminates.
SELECT _assert(
  (SELECT finished_at > started_at FROM pipeline_runs),
  'finished_at is stamped by the function, so duration is measurable'
);

-- 🚨 THE PIN THAT MAKES duration_ms REAL — written the way production calls it.
-- Every caller passes `clock_timestamp()` captured at its own entry, which is
-- LATER than transaction start. Under the pre-2026-08-23 body (`now()`) the
-- function stamped transaction start, so finished_at landed BEFORE started_at and
-- the GREATEST-clamped duration_ms was a hard 0. The sleep makes the gap
-- unambiguous rather than a microsecond race.
DO $clockskew$
DECLARE
  v_started timestamptz;
BEGIN
  PERFORM pg_sleep(0.05);
  v_started := clock_timestamp();
  PERFORM public.log_pipeline_run('clockskew', v_started);
END
$clockskew$;

SELECT _assert(
  (SELECT finished_at >= started_at FROM pipeline_runs WHERE pipeline='clockskew'),
  'a caller passing clock_timestamp() gets finished_at AT OR AFTER it — this is FALSE under now()'
);
SELECT _assert(
  (SELECT finished_at > now() FROM pipeline_runs WHERE pipeline='clockskew'),
  'finished_at is WALL-CLOCK, not transaction start — this is the one word the whole metric rests on'
);

-- THE COUNTER INVARIANT: explicit NULLs must land as 0, never NULL.
SELECT public.log_pipeline_run('nulls', now(), NULL, NULL, NULL);
SELECT _assert_eq(
  (SELECT rows_found::text FROM pipeline_runs WHERE pipeline='nulls'), '0',
  'NULL rows_found COALESCEs to 0 (a NULL would poison every downstream SUM)'
);
SELECT _assert_eq(
  (SELECT rows_written::text FROM pipeline_runs WHERE pipeline='nulls'), '0',
  'NULL rows_written COALESCEs to 0'
);
SELECT _assert_eq(
  (SELECT rows_skipped::text FROM pipeline_runs WHERE pipeline='nulls'), '0',
  'NULL rows_skipped COALESCEs to 0'
);

-- Omitted counters use the same 0 defaults (the common call shape).
SELECT public.log_pipeline_run('defaults', now());
SELECT _assert_eq(
  (SELECT (rows_found + rows_written + rows_skipped)::text FROM pipeline_runs WHERE pipeline='defaults'),
  '0', 'omitted counters default to 0, not NULL'
);

-- Failure path: ok=false + error text survive, since that pair is what the
-- alerting predicate keys on.
SELECT public.log_pipeline_run(
  'failing', now(), 0, 0, 0, false, 'boom', 'nba_top_shot', 'c1', 'c2',
  '{"reason":"test"}'::jsonb
);
SELECT _assert_eq((SELECT ok::text FROM pipeline_runs WHERE pipeline='failing'), 'false', 'ok=false persists');
SELECT _assert_eq((SELECT error FROM pipeline_runs WHERE pipeline='failing'), 'boom', 'error text persists');
SELECT _assert_eq(
  (SELECT collection_slug FROM pipeline_runs WHERE pipeline='failing'), 'nba_top_shot',
  'collection_slug persists (per-collection health arms read it)'
);
SELECT _assert_eq(
  (SELECT extra->>'reason' FROM pipeline_runs WHERE pipeline='failing'), 'test',
  'extra jsonb persists (payload-shape drift tracking reads it)'
);
SELECT _assert_eq(
  (SELECT cursor_before FROM pipeline_runs WHERE pipeline='failing'), 'c1',
  'cursor_before persists'
);
SELECT _assert_eq(
  (SELECT cursor_after FROM pipeline_runs WHERE pipeline='failing'), 'c2',
  'cursor_after persists'
);

ROLLBACK;
