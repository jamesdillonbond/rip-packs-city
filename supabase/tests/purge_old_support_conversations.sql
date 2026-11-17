-- DB invariant: public.purge_old_support_conversations — the 90-day retention
-- sweep for concierge conversation history, called by run_weekly_log_purges()
-- (pg_cron `rpc-weekly-log-purges`, daily 09:40Z).
--
-- ⚠ THE CLAUSE THAT MATTERS IS NOT THE AGE, IT IS `feedback_type IS NULL`.
-- A conversation the user gave feedback on is kept FOREVER, regardless of age.
-- That is the only durable record of what a real collector told us the product
-- got wrong, it is the input to every concierge-quality judgement, and losing it
-- is unrecoverable — there is no upstream to re-fetch from. Over-deletion here
-- produces an ABSENCE, not an error: nothing downstream raises, the rows are
-- simply gone and the next reader concludes nobody ever gave feedback.
--
-- Deletion volume is real, not hypothetical: `weekly-db-maintenance` reported
-- support_conversations_deleted 26 (08-19) and 56 (08-18). This function runs
-- daily against live user data.
--
-- ⚠ NO COMMITTED MIGRATION DEFINES THIS FUNCTION — it is one of the fileless
-- migrations `check-migration-parity.mjs` reports (applied via MCP, file never
-- committed). The DDL below is VERBATIM from live prod via pg_get_functiondef
-- on 2026-08-20, snapshotted into
-- supabase/migrations/20260821021000_audit_20260820_snapshot_retention_purges.sql
-- so __tests__/db-invariants-drift-guard.test.ts has a source to compare against.
-- That snapshot is a CREATE OR REPLACE with a byte-identical body, so applying it
-- is a no-op; it is committed for provenance, not to be run.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Types match information_schema, not intuition: `id` is bigint, `created_at`
-- is timestamptz, `feedback_type` is text. A fixture that merely WIDENS a type
-- passes while testing a shape production cannot produce.
CREATE TABLE public.support_conversations (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at    timestamptz,
  feedback_type text
);

-- >>> BEGIN verbatim purge_old_support_conversations (byte-identical to prod) >>>
CREATE OR REPLACE FUNCTION public.purge_old_support_conversations(p_days_keep integer DEFAULT 90)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_deleted integer;
BEGIN
  DELETE FROM support_conversations
  WHERE created_at < NOW() - (p_days_keep || ' days')::interval
    AND feedback_type IS NULL;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;
-- <<< END verbatim purge_old_support_conversations <<<

-- ⚠ THE BOUNDARY ROW IS THE WHOLE POINT OF THIS FIXTURE. `NOW()` is
-- transaction-stable, so a row inserted at exactly `now() - 90 days` sits ON the
-- cutoff: `<` KEEPS it, `<=` deletes it. Without this row the `<` → `<=`
-- mutation survives, and the test reads as thorough while proving nothing about
-- the edge — one of the five documented vacuous shapes.
INSERT INTO public.support_conversations (created_at, feedback_type) VALUES
  (now() - interval '200 days', NULL),      -- ancient, no feedback  → purge
  (now() - interval '91 days',  NULL),      -- just outside window   → purge
  (now() - interval '90 days',  NULL),      -- EXACTLY on the cutoff → keep (`<`)
  (now() - interval '89 days',  NULL),      -- inside the window     → keep
  (now() - interval '200 days', 'thumbs_down'), -- ancient WITH feedback → keep forever
  (now() - interval '400 days', 'thumbs_up'),   -- older still, WITH feedback → keep
  (NULL,                        NULL);      -- NULL created_at → never age-purged

SELECT _assert_eq(public.purge_old_support_conversations()::text, '2',
  'default 90-day retention deletes exactly the two feedback-less rows older than the cutoff');

SELECT _assert_eq((SELECT count(*)::text FROM public.support_conversations), '5',
  'the boundary row, the in-window row, both feedback rows and the NULL-date row all survive');

-- Assert the ABSENCE of the destructive outcome, not merely the presence of a
-- count: a count can be right while the wrong rows went.
SELECT _assert(
  (SELECT count(*) FROM public.support_conversations WHERE feedback_type IS NOT NULL) = 2,
  'a conversation carrying feedback is NEVER purged by age — the clause this function exists for');

SELECT _assert(
  EXISTS (SELECT 1 FROM public.support_conversations
           WHERE feedback_type IS NULL AND created_at = (SELECT max(created_at)
             FROM public.support_conversations WHERE feedback_type IS NULL)),
  'the newest feedback-less row is kept');

-- The boundary, stated as its own assertion so a failure names the cause.
SELECT _assert(
  (SELECT count(*) FROM public.support_conversations
    WHERE feedback_type IS NULL
      AND created_at BETWEEN now() - interval '90 days' - interval '1 second'
                         AND now() - interval '90 days' + interval '1 second') = 1,
  'a row EXACTLY on the 90-day cutoff is kept (the < vs <= boundary)');

SELECT _assert(
  EXISTS (SELECT 1 FROM public.support_conversations WHERE created_at IS NULL),
  'a NULL created_at is never purged by age');

-- The retention window is a PARAMETER, and run_weekly_log_purges passes 90
-- explicitly. Drive a non-default value so a hardcoded interval in the body
-- (ignoring p_days_keep) cannot pass.
SELECT _assert_eq(public.purge_old_support_conversations(30)::text, '2',
  'a tighter 30-day window reaches the boundary and in-window rows too');
SELECT _assert(
  (SELECT count(*) FROM public.support_conversations WHERE feedback_type IS NOT NULL) = 2,
  'even at a tighter retention, feedback rows are still exempt');

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.support_conversations), '3',
  'after the 30-day sweep only the two feedback rows and the NULL-date row remain');

ROLLBACK;
