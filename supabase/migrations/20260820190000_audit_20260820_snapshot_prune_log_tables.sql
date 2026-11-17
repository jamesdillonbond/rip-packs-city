-- Snapshot of public.prune_log_tables — 2026-08-20.
--
-- ⚠ THIS FUNCTION HAD NO MIGRATION ANYWHERE IN THE REPO. It is live, it is
-- called on a schedule by app/api/cron/prune-logs/route.ts, and it issues THREE
-- DELETEs — and `grep -rn prune_log_tables supabase/migrations/` returned
-- nothing. So prod carried a deleter whose DDL the repo could not describe, and
-- therefore had no revert path and nothing to pin a DB-invariant test against.
--
-- ⚠ NOT APPLIED VIA `apply_migration`, DELIBERATELY. The body below is byte-
-- identical to live (captured with `pg_get_functiondef` on 2026-08-20), so this
-- is a `CREATE OR REPLACE` that is a semantic NO-OP — there is nothing to
-- change. Applying it would buy nothing and cost the usual ~10–20 s burst of
-- user-facing PGRST002 500s from the schema-cache re-introspection. Committed
-- for the record and for supabase/tests/prune_log_tables.sql to pin against;
-- scripts/check-migration-parity.mjs checks prod→repo (applied-but-uncommitted)
-- and is unaffected by a committed-but-unapplied snapshot.
--
-- ⚠ THE FIRST LEG IS DEAD IN PRACTICE, and that is worth knowing before anyone
-- "fixes" it. `pipeline_runs` is pruned to ~3 days by `prune_pipeline_runs(3)`
-- on pg_cron (measured 2026-08-20: oldest row 73.3 h old, exactly the ~73 h
-- CLAUDE.md documents). This function's own pipeline_runs leg uses a 14-day
-- cutoff, so by the time it runs there is never anything older than 14 days
-- left — `pipeline_runs_deleted` is structurally ALWAYS 0. That is a
-- "nothing to do" zero, not a "nothing happened" zero; do not read it as either
-- health or breakage.

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

-- ── anon-exec decision ──────────────────────────────────────────────────────
-- anon-exec: already revoked, unchanged by this migration (prune_log_tables)
--
-- Live state verified 2026-08-20 with `has_function_privilege`, never the acl
-- text: anon=false, authenticated=false, service_role=true. SECURITY DEFINER,
-- three DELETE legs — correctly locked down already.
--
-- ⚠ A REVOKE BELONGS IN A REAL MIGRATION, NOT IN A SNAPSHOT, and I had written
-- one here before the guard corrected me. Its reasoning is better than mine was:
-- `CREATE OR REPLACE FUNCTION` does NOT reset a function's ACL, so the DDL above
-- is genuinely inert — but a REVOKE is an ACTIVE privilege change that WOULD
-- alter production if this file were ever applied. A snapshot must be able to
-- run as a no-op, so it states the decision instead of re-asserting it.
