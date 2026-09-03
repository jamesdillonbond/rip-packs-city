-- DB invariant: public.detect_stalled_pipelines — the cadence watcher behind
-- rpc_ops_snapshot.
--
-- ⛔ WHAT IS PINNED, AND WHY IT NEEDS A TEST RATHER THAN A READING.
-- On 2026-09-02 this function gained three fields that classify a silent
-- pipeline: `heartbeat_last_run`, `uncorrelated_heartbeats` and
-- `classification`. They exist to separate two causes that produce an IDENTICAL
-- terminal-row signature and need OPPOSITE responses — the schedule stopped
-- firing, versus the route fires and is killed at its lambda wall before it can
-- log. A `maxDuration` kill cannot be caught by `try/catch`, so the killed case
-- writes nothing at all.
--
-- 🚨 THE ±5 s CORRELATION IS THE PART THAT MUST NOT REGRESS, and it is not
-- obvious. The first draft counted a heartbeat as orphaned when
-- `started_at > last_run`. Against LIVE data that reported three healthy
-- pipelines as orphaned — their marker is written 2–14 ms after the terminal
-- row's `started_at`, because the two timestamps come from different clocks in
-- the route, so a tick was counting ITS OWN heartbeat as evidence of its own
-- death. Both directions are pinned below: a 14 ms skew must NOT count, a 30 s
-- gap MUST.
--
-- ⛔ AND THE ROW SET MUST NOT MOVE. A marker must never refresh the real
-- pipeline's silence clock — that is the whole reason the helper writes under a
-- suffixed name — so a healthy pipeline with a fresh heartbeat must stay OUT of
-- the output no matter what its markers say.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260903024204_audit_20260902_detect_stalled_pipelines_says_whether_the_schedule_is_firing.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pipeline_cadence_watchlist (
  pipeline           text primary key,
  max_silent_minutes integer,
  severity           text,
  notes              text,
  is_active          boolean
);

-- duration_ms is GENERATED in prod and irrelevant here, so the fixture stays
-- vanilla-Postgres.
CREATE TABLE public.pipeline_runs (
  id         bigserial primary key,
  pipeline   text,
  started_at timestamptz,
  ok         boolean
);

-- >>> BEGIN verbatim detect_stalled_pipelines (byte-identical to the migration) >>>
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
           'heartbeat_last_run', hbl.last_hb,
           'uncorrelated_heartbeats', orp.uncorrelated,
           'classification',
             CASE
               WHEN hbl.last_hb IS NULL THEN 'no_marker'
               WHEN (extract(epoch from (now()-hbl.last_hb))/60) <= w.max_silent_minutes
                 THEN 'invoked_but_never_logged'
               ELSE 'not_invoked'
             END,
           'notes', w.notes
         ) ORDER BY (extract(epoch from (now()-lr.last_run))/60) DESC NULLS FIRST), '[]'::jsonb)
  FROM pipeline_cadence_watchlist w
  LEFT JOIN LATERAL (
    SELECT max(started_at) AS last_run FROM pipeline_runs pr WHERE pr.pipeline = w.pipeline
  ) lr ON true
  LEFT JOIN LATERAL (
    SELECT max(h.started_at) AS last_hb
    FROM pipeline_runs h WHERE h.pipeline = w.pipeline || '-heartbeat'
  ) hbl ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS uncorrelated FROM pipeline_runs h
    WHERE h.pipeline = w.pipeline || '-heartbeat'
      AND h.started_at > COALESCE(lr.last_run, now() - interval '30 days') - interval '5 s'
      AND NOT EXISTS (SELECT 1 FROM pipeline_runs t
                      WHERE t.pipeline = w.pipeline
                        AND t.started_at BETWEEN h.started_at - interval '5 s'
                                             AND h.started_at + interval '5 s')
  ) orp ON true
  WHERE w.is_active
    AND (lr.last_run IS NULL OR (extract(epoch from (now()-lr.last_run))/60) > w.max_silent_minutes);
$function$;
-- <<< END verbatim detect_stalled_pipelines <<<

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active) VALUES
  ('healthy',        60, 'medium', NULL, true),
  ('killed',         60, 'high',   NULL, true),
  ('not-invoked',    60, 'medium', NULL, true),
  ('no-marker',      60, 'medium', NULL, true),
  ('skew-14ms',      60, 'medium', NULL, true),
  ('skew-30s',       60, 'medium', NULL, true),
  ('inactive',       60, 'medium', NULL, false);

INSERT INTO public.pipeline_runs (pipeline, started_at, ok) VALUES
  -- HEALTHY: a fresh terminal row. It also has a fresh marker, which must not
  -- pull it into the output — the enrichment is not allowed to move the row set.
  ('healthy',              now() - interval '2 minutes',  true),
  ('healthy-heartbeat',    now() - interval '2 minutes',  true),

  -- KILLED: silent for 10 h, but the marker landed a minute ago, so the schedule
  -- IS firing and every invocation since the last terminal row died at the wall.
  ('killed',               now() - interval '10 hours',   true),
  ('killed-heartbeat',     now() - interval '10 hours',   true),   -- correlated with the terminal row
  ('killed-heartbeat',     now() - interval '40 minutes', true),
  ('killed-heartbeat',     now() - interval '1 minute',   true),

  -- NOT INVOKED: the marker is as old as the terminal row. Nothing is firing.
  ('not-invoked',           now() - interval '10 hours',  true),
  ('not-invoked-heartbeat', now() - interval '10 hours',  true),

  -- NO MARKER: this route was never converted, so the function must say it
  -- cannot tell — the third state, not a guess in either direction.
  ('no-marker',             now() - interval '10 hours',  true),

  -- SKEW 14 ms: THE LIVE FALSE POSITIVE. Marker written a hair after the
  -- terminal row of the SAME tick. It must NOT be counted as orphaned.
  ('skew-14ms',             now() - interval '10 hours',  true),
  ('skew-14ms-heartbeat',   now() - interval '10 hours' + interval '14 milliseconds', true),

  -- SKEW 30 s: the control in the other direction. Outside the ±5 s window, so
  -- it IS a marker with no terminal row and must be counted.
  ('skew-30s',              now() - interval '10 hours',  true),
  ('skew-30s-heartbeat',    now() - interval '10 hours' + interval '30 seconds', true),

  -- INACTIVE: silent for a week, and must stay out regardless.
  ('inactive',              now() - interval '7 days',    true);

DO $$
DECLARE
  v jsonb := public.detect_stalled_pipelines();
  o jsonb;
BEGIN
  -- NON-VACUITY FIRST. Every assertion below is a lookup into `v`; if the walk
  -- returned nothing they would all pass on absence.
  PERFORM _assert(jsonb_array_length(v) = 5,
    'expected 5 stalled rows, got ' || jsonb_array_length(v) || ': ' || v::text);

  -- ── the row set is unchanged by the enrichment ──────────────────────────
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v) e WHERE e->>'pipeline' = 'healthy'),
    'a HEALTHY pipeline with a fresh marker was pulled into the output — the marker moved the row set');
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v) e WHERE e->>'pipeline' = 'inactive'),
    'an is_active=false row appeared');

  -- ── classification, all three states ────────────────────────────────────
  SELECT e INTO o FROM jsonb_array_elements(v) e WHERE e->>'pipeline' = 'killed';
  PERFORM _assert_eq(o->>'classification', 'invoked_but_never_logged',
    'a pipeline whose marker is fresher than its silence window is being invoked and killed');
  -- Two markers postdate the last terminal row; the third correlates with it.
  PERFORM _assert_eq(o->>'uncorrelated_heartbeats', '2',
    'killed: uncorrelated marker count');

  SELECT e INTO o FROM jsonb_array_elements(v) e WHERE e->>'pipeline' = 'not-invoked';
  PERFORM _assert_eq(o->>'classification', 'not_invoked',
    'a marker as old as the terminal row means nothing is firing');
  PERFORM _assert_eq(o->>'uncorrelated_heartbeats', '0', 'not-invoked: no orphaned marker');

  SELECT e INTO o FROM jsonb_array_elements(v) e WHERE e->>'pipeline' = 'no-marker';
  PERFORM _assert_eq(o->>'classification', 'no_marker',
    'an unconverted route must report that it CANNOT tell, not guess');
  PERFORM _assert(o->>'heartbeat_last_run' IS NULL, 'no-marker: heartbeat_last_run must be null');
  PERFORM _assert_eq(o->>'uncorrelated_heartbeats', '0', 'no-marker: nothing to count');

  -- ── the ±5 s window, both directions ────────────────────────────────────
  SELECT e INTO o FROM jsonb_array_elements(v) e WHERE e->>'pipeline' = 'skew-14ms';
  PERFORM _assert_eq(o->>'uncorrelated_heartbeats', '0',
    'a marker 14ms after its own terminal row is the SAME tick and must not count as a kill — '
    'this is the live false positive a bare > comparison produced on three healthy pipelines');

  SELECT e INTO o FROM jsonb_array_elements(v) e WHERE e->>'pipeline' = 'skew-30s';
  PERFORM _assert_eq(o->>'uncorrelated_heartbeats', '1',
    'a marker 30s past its terminal row is outside the window and MUST count — without this the '
    'tolerance could be widened to infinity and every assertion above would still pass');
END $$;

ROLLBACK;
