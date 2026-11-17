-- DB invariant: public.prune_log_tables — the three-table retention sweep called
-- by app/api/cron/prune-logs/route.ts.
--
-- ⚠ WHY THIS EXISTS. The only test that touched this path
-- (__tests__/api-cron-prune-logs.test.ts) FIXTURES the RPC: it proves the route
-- calls the function and handles the response, which is worth having and says
-- nothing whatever about what the function deletes. Retention cutoffs are the
-- documented `<` vs `<=` boundary class, and over-deletion here produces an
-- ABSENCE, not an error — the same misreading that made two sessions conclude a
-- live pipeline had never run.
--
-- The function DDL below is VERBATIM from
-- supabase/migrations/20260820190000_audit_20260820_snapshot_prune_log_tables.sql,
-- itself captured byte-identical from live via pg_get_functiondef on 2026-08-20.
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Minimal stand-ins. Only the columns the predicates read are modelled.
CREATE TABLE public.pipeline_runs (
  id bigserial primary key, pipeline text, started_at timestamptz
);
CREATE TABLE public.listing_resolution_failures (
  id bigserial primary key, note text, resolved_at timestamptz, first_seen_at timestamptz
);
CREATE TABLE public.smoke_test_results (
  id bigserial primary key, note text, ran_at timestamptz
);

-- >>> BEGIN verbatim prune_log_tables (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.prune_log_tables()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_pipeline_runs_deleted int;
  v_listing_failures_deleted int;
  v_smoke_test_deleted int;
BEGIN
  WITH d AS (
    DELETE FROM public.pipeline_runs
    WHERE started_at < now() - interval '14 days'
    RETURNING 1
  )
  SELECT count(*) INTO v_pipeline_runs_deleted FROM d;

  WITH d AS (
    DELETE FROM public.listing_resolution_failures
    WHERE resolved_at IS NOT NULL
       OR first_seen_at < now() - interval '3 days'
    RETURNING 1
  )
  SELECT count(*) INTO v_listing_failures_deleted FROM d;

  WITH d AS (
    DELETE FROM public.smoke_test_results
    WHERE ran_at < now() - interval '30 days'
    RETURNING 1
  )
  SELECT count(*) INTO v_smoke_test_deleted FROM d;

  RETURN jsonb_build_object(
    'pipeline_runs_deleted', v_pipeline_runs_deleted,
    'listing_resolution_failures_deleted', v_listing_failures_deleted,
    'smoke_test_results_deleted', v_smoke_test_deleted,
    'completed_at', now()
  );
END;
$function$;
-- <<< END verbatim prune_log_tables <<<

-- ── Each leg keeps what is inside its own window ────────────────────────────
-- Three different intervals (14d / 3d / 30d) on three tables. Seeded together so
-- a leg that reached the WRONG table would show up as a survivor count moving on
-- a table it has no business touching.
INSERT INTO public.pipeline_runs (pipeline, started_at) VALUES
  ('old', now() - interval '15 days'), ('young', now() - interval '13 days');
INSERT INTO public.listing_resolution_failures (note, resolved_at, first_seen_at) VALUES
  ('stale-unresolved', NULL, now() - interval '4 days'),
  ('fresh-unresolved', NULL, now() - interval '2 days'),
  ('resolved-but-brand-new', now(), now() - interval '1 minute');
INSERT INTO public.smoke_test_results (note, ran_at) VALUES
  ('old', now() - interval '31 days'), ('young', now() - interval '29 days');

SELECT _assert_eq((public.prune_log_tables() ->> 'pipeline_runs_deleted'), '1',
  'pipeline_runs: only the 15-day row is past the 14-day cutoff');
SELECT _assert(EXISTS (SELECT 1 FROM public.pipeline_runs WHERE pipeline = 'young'),
  'pipeline_runs: the 13-day row is inside the window and survives');
SELECT _assert_eq((SELECT count(*)::text FROM public.smoke_test_results), '1',
  'smoke_test_results: the 29-day row survives its 30-day window');
SELECT _assert(EXISTS (SELECT 1 FROM public.smoke_test_results WHERE note = 'young'),
  'smoke_test_results: it kept the RIGHT row');

-- ⚠ The listing_resolution_failures leg is an OR, not an age window ──────────
-- `resolved_at IS NOT NULL OR first_seen_at < cutoff` deletes EVERY resolved row
-- regardless of age — a one-minute-old resolved row goes. That is intended (a
-- resolved failure has no diagnostic value) but it is NOT what "3 days
-- retention" implies, and it is the leg most likely to be mis-summarised in a
-- comment. Pinned so the OR cannot quietly become an AND, which would strand
-- resolved rows forever and let the table grow without bound.
SELECT _assert(NOT EXISTS (SELECT 1 FROM public.listing_resolution_failures WHERE note = 'resolved-but-brand-new'),
  'a RESOLVED failure is deleted at any age — the predicate is an OR, not an age window');
SELECT _assert(NOT EXISTS (SELECT 1 FROM public.listing_resolution_failures WHERE note = 'stale-unresolved'),
  'an UNRESOLVED failure older than 3 days is deleted');
SELECT _assert_eq((SELECT count(*)::text FROM public.listing_resolution_failures), '1',
  'only the fresh unresolved failure survives');

-- ── The boundary is STRICTLY less-than, on ALL THREE legs ───────────────────
-- ⚠ The fixture must sit EXACTLY ON each cutoff. A row merely NEAR the boundary
-- is kept under both `<` and `<=`, so it asserts nothing — the sibling pin
-- (prune_pipeline_runs.sql) records a `< → <=` mutation surviving exactly that
-- mistake. `now()` is transaction-stable and the function computes
-- `now() - interval '<n>'`, so a row inserted at the same expression inside this
-- transaction lands precisely on the cutoff. `<` keeps it; `<=` deletes it.
DELETE FROM public.pipeline_runs;
DELETE FROM public.listing_resolution_failures;
DELETE FROM public.smoke_test_results;
INSERT INTO public.pipeline_runs (pipeline, started_at) VALUES ('boundary', now() - interval '14 days');
INSERT INTO public.listing_resolution_failures (note, resolved_at, first_seen_at)
  VALUES ('boundary', NULL, now() - interval '3 days');
INSERT INTO public.smoke_test_results (note, ran_at) VALUES ('boundary', now() - interval '30 days');

SELECT _assert_eq((public.prune_log_tables() ->> 'pipeline_runs_deleted'), '0',
  'pipeline_runs: a row exactly AT the 14-day cutoff is kept');
SELECT _assert_eq((SELECT count(*)::text FROM public.listing_resolution_failures), '1',
  'listing_resolution_failures: a row exactly AT the 3-day cutoff is kept');
SELECT _assert_eq((SELECT count(*)::text FROM public.smoke_test_results), '1',
  'smoke_test_results: a row exactly AT the 30-day cutoff is kept');

-- ── A NULL timestamp is never age-pruned ────────────────────────────────────
-- `NULL < cutoff` is NULL, so the row survives. Pinned because COALESCE-ing to
-- epoch would delete precisely the rows a writer failed to stamp — the ones most
-- likely to indicate something broken. ⚠ Note the asymmetry: a NULL
-- `first_seen_at` still goes if `resolved_at` is set, because the OR's first
-- branch does not read the timestamp at all.
DELETE FROM public.pipeline_runs;
DELETE FROM public.listing_resolution_failures;
DELETE FROM public.smoke_test_results;
INSERT INTO public.pipeline_runs (pipeline, started_at) VALUES ('nostamp', NULL);
INSERT INTO public.listing_resolution_failures (note, resolved_at, first_seen_at) VALUES ('nostamp', NULL, NULL);
INSERT INTO public.smoke_test_results (note, ran_at) VALUES ('nostamp', NULL);
SELECT _assert_eq((public.prune_log_tables() ->> 'pipeline_runs_deleted'), '0',
  'a NULL started_at is never pruned by age');
SELECT _assert_eq((SELECT count(*)::text FROM public.listing_resolution_failures), '1',
  'a NULL first_seen_at with NULL resolved_at survives');
SELECT _assert_eq((SELECT count(*)::text FROM public.smoke_test_results), '1',
  'a NULL ran_at is never pruned by age');

-- ── The payload is the operator-facing record ───────────────────────────────
SELECT _assert(((public.prune_log_tables() ->> 'completed_at') IS NOT NULL),
  'the payload stamps completed_at');
SELECT _assert_eq((public.prune_log_tables() ->> 'listing_resolution_failures_deleted'), '0',
  're-running immediately is a no-op — the sweep is idempotent within a window');

SELECT '✓ prune_log_tables invariants pass' AS result;
ROLLBACK;
