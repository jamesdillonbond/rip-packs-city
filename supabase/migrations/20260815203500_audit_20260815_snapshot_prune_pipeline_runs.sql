-- audit_20260815_snapshot_prune_pipeline_runs
--
-- SNAPSHOT MIGRATION — not a change. This captures the CURRENT live definition
-- of public.prune_pipeline_runs verbatim (pg_get_functiondef, 2026-08-15) so the
-- function becomes PINNABLE: supabase/tests/prune_pipeline_runs.sql embeds the
-- same DDL, and __tests__/db-invariants-drift-guard.test.ts fails CI if the two
-- diverge. Applying it is a byte-identical no-op.
--
-- WHY THIS FUNCTION. It runs on pg_cron (`41 */6 * * *`) and DELETES from
-- pipeline_runs — the table every pipeline-health instrument reads
-- (detect_stalled_pipelines(), get_pipeline_alerts(), the sentinel, the daily
-- rollup). It was one of 25 scheduled SECDEF WRITERS with no pin at all.
--
-- The invariant that matters is the retention BOUNDARY. Over-deleting here is
-- silent and unrecoverable in kind: pipeline_runs is the only record that a run
-- happened, so a row deleted early does not become an error, it becomes an
-- absence — indistinguishable from "the pipeline never ran". That is the exact
-- misreading CLAUDE.md warns about ("no matching record in pipeline_runs is
-- usually a RETENTION ARTIFACT, not a finding").
--
-- Note the DEFAULT is 14 days while pg_cron passes 3 explicitly (~73h live
-- retention). Both paths are pinned by the test.

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
