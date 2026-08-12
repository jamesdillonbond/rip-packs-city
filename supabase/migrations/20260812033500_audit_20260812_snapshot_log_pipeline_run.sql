-- audit_20260812_snapshot_log_pipeline_run
--
-- SNAPSHOT migration — commits the VERBATIM live definition of the canonical
-- 11-arg public.log_pipeline_run so the function becomes PINNABLE by the
-- DB-invariant layer. It was applied via the Supabase MCP with no committed
-- DDL, so __tests__/db-invariants-drift-guard.test.ts had nothing to compare a
-- pin against (the documented "UNPINNABLE until someone authors a snapshot
-- migration first" gap).
--
-- Byte-identical to live `pg_get_functiondef` as of 2026-08-12, so applying it
-- is a NO-OP. Nothing about the function's behaviour changes here.
--
-- Why this one first: it has 129 call sites — more than any other RPC in the
-- codebase — and it is the write path behind `pipeline_runs`, which is the
-- substrate for detect_stalled_pipelines(), get_pipeline_alerts(), the sentinel
-- and the daily rollup. If its COALESCE-to-0 behaviour regressed to writing
-- NULL counts, every downstream health sum would go NULL and pipelines would
-- read as healthy-but-empty rather than broken — a silent failure in the exact
-- layer whose job is to make failure loud.
--
-- NOTE the 3-arg overload log_pipeline_run(text, boolean, jsonb) is a DIFFERENT
-- function with its own committed migration
-- (20260713233000_audit_20260713_log_pipeline_run_3arg_overload.sql); it
-- delegates here. Do not conflate them.
--
-- Revert: none needed (no-op snapshot). Dropping this file only removes the
-- pin's comparison target and re-opens the drift hole.

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
    p_pipeline, p_collection_slug, p_started_at, now(),
    COALESCE(p_rows_found,0), COALESCE(p_rows_written,0), COALESCE(p_rows_skipped,0),
    p_cursor_before, p_cursor_after, p_ok, p_error, p_extra
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;
