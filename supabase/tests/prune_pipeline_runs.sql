-- DB invariant: public.prune_pipeline_runs — the retention sweep for
-- pipeline_runs, on pg_cron `41 */6 * * *`.
--
-- pipeline_runs is the ONLY record that a run happened, and every pipeline-health
-- instrument reads it (detect_stalled_pipelines(), get_pipeline_alerts(), the
-- sentinel, the daily rollup). So over-deletion here is not an error, it is an
-- ABSENCE — indistinguishable from "the pipeline never ran", which is exactly the
-- misreading CLAUDE.md records two sessions independently making. That makes the
-- retention BOUNDARY the invariant worth pinning, in both directions.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260815203500_audit_20260815_snapshot_prune_pipeline_runs.sql),
-- whose body was verified byte-identical to live prod via prosrc md5 on
-- 2026-08-15. __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Minimal stand-in for the real table. duration_ms is GENERATED in prod; it is
-- irrelevant here and deliberately omitted so the fixture stays vanilla-Postgres.
CREATE TABLE public.pipeline_runs (
  id         bigserial primary key,
  pipeline   text,
  started_at timestamptz,
  ok         boolean
);

-- >>> BEGIN verbatim prune_pipeline_runs (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.prune_pipeline_runs(p_retention_days integer DEFAULT 14)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_deleted bigint;
  v_cutoff timestamptz;
BEGIN
  v_cutoff := NOW() - (p_retention_days || ' days')::interval;

  DELETE FROM pipeline_runs WHERE started_at < v_cutoff;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'deleted', v_deleted,
    'retention_days', p_retention_days,
    'cutoff', v_cutoff,
    'remaining', (SELECT COUNT(*) FROM pipeline_runs)
  );
END;
$function$;
-- <<< END verbatim prune_pipeline_runs <<<

INSERT INTO public.pipeline_runs (pipeline, started_at, ok) VALUES
  ('a', now() - interval '30 days',  true),   -- far past any retention
  ('b', now() - interval '15 days',  true),   -- past the 14-day DEFAULT
  ('c', now() - interval '13 days',  true),   -- inside the 14-day DEFAULT
  ('d', now() - interval '4 days',   true),   -- past the cron's explicit 3
  ('e', now() - interval '2 days',   false),  -- inside the cron's explicit 3
  ('f', now() - interval '1 hour',   true);   -- the current wave

-- ── The DEFAULT (14 days), which is NOT what the cron passes ────────────────
-- Run first, on the full fixture: it must drop only the two rows older than 14d
-- and leave the 13-day row, which the cron's tighter window would take.
SELECT _assert_eq((public.prune_pipeline_runs() ->> 'retention_days'), '14',
  'the default retention is 14 days (the cron overrides it with 3)');
SELECT _assert_eq((SELECT count(*)::text FROM public.pipeline_runs), '4',
  'the 14-day default removed a and b only');
SELECT _assert(
  EXISTS (SELECT 1 FROM public.pipeline_runs WHERE pipeline = 'c'),
  'the 13-day-old run survives the 14-day default');

-- ── The cron's ACTUAL call: prune_pipeline_runs(3) ──────────────────────────
-- Pinned separately from the default because the live retention window (~73h) is
-- the ARGUMENT, not the signature: a change to the DEFAULT would not move prod,
-- and a change here would.
SELECT _assert_eq((public.prune_pipeline_runs(3) ->> 'deleted'), '2',
  'retention_days=3 then removes the 13-day and 4-day runs');
SELECT _assert_eq((SELECT count(*)::text FROM public.pipeline_runs), '2',
  'the two runs inside the 3-day window survive');
SELECT _assert(
  NOT EXISTS (SELECT 1 FROM public.pipeline_runs WHERE pipeline IN ('a','b','c','d')),
  'every run older than the cutoff is gone');
SELECT _assert(
  EXISTS (SELECT 1 FROM public.pipeline_runs WHERE pipeline = 'e'),
  'a FAILED run inside the window is retained — retention is by AGE only, never by ok');

-- ── The returned payload is the operator-facing record of what was deleted ──
-- Read by whoever is checking whether a missing row is a retention artifact, so
-- a wrong `remaining` misdirects that check.
SELECT _assert_eq((public.prune_pipeline_runs(3) ->> 'deleted'), '0',
  're-running immediately is a no-op — the sweep is idempotent within a window');
SELECT _assert_eq((public.prune_pipeline_runs(3) ->> 'remaining'), '2',
  'remaining reports the post-delete count, not the pre-delete one');
SELECT _assert_eq((public.prune_pipeline_runs(3) ->> 'retention_days'), '3',
  'the payload echoes the retention actually applied');

-- ── The boundary is STRICTLY less-than ─────────────────────────────────────
-- ⚠ The fixture must sit EXACTLY ON the cutoff, not near it. A first version of
-- this used `cutoff + 1 second` and the `< → <=` mutation SURVIVED, because a
-- row inside the window is kept under either operator — a boundary test that is
-- not on the boundary asserts nothing.
--
-- `NOW()` is transaction-stable and the function computes `NOW() - p_days`, so
-- inserting `now() - interval '3 days'` inside the same transaction lands the
-- row precisely on v_cutoff. `<` keeps it; `<=` deletes it.
DELETE FROM public.pipeline_runs;
INSERT INTO public.pipeline_runs (pipeline, started_at, ok)
VALUES ('boundary', now() - interval '3 days', true);
SELECT _assert_eq((public.prune_pipeline_runs(3) ->> 'deleted'), '0',
  'a row exactly AT the cutoff is kept — the comparison is strictly less-than');
SELECT _assert_eq((SELECT count(*)::text FROM public.pipeline_runs), '1',
  'the boundary row survives the sweep');

-- ── A NULL started_at is never age-pruned ───────────────────────────────────
-- `NULL < cutoff` is NULL, so the row survives. Pinned because the alternative
-- (COALESCE-ing it to epoch) would silently delete every row a writer failed to
-- stamp — i.e. the rows most likely to indicate a broken pipeline.
DELETE FROM public.pipeline_runs;
INSERT INTO public.pipeline_runs (pipeline, started_at, ok) VALUES ('nostamp', NULL, true);
SELECT _assert_eq((public.prune_pipeline_runs(0) ->> 'deleted'), '0',
  'a row with a NULL started_at is never pruned by age');
SELECT _assert_eq((SELECT count(*)::text FROM public.pipeline_runs), '1',
  'the unstamped row is still there');

SELECT '✓ prune_pipeline_runs invariants pass' AS result;
ROLLBACK;
