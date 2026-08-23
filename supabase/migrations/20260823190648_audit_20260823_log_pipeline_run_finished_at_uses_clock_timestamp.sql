-- audit_20260823_log_pipeline_run_finished_at_uses_clock_timestamp
--
-- ✅ ALREADY APPLIED TO PRODUCTION 2026-08-23 19:06:48Z via Supabase MCP
-- `apply_migration`, registered as version `20260823190648` under this exact name.
-- ⚠ THIS FILE IS THE MISSING GIT HALF, NOT A NEW CHANGE. It is a byte-identical
-- capture of the live definition (`md5(pg_get_functiondef(...))` =
-- 6dd327eea2dfb888e0340816dddc9fe8, verified against the database rather than by
-- eye). Re-applying it would be a no-op and would cost a ~10-20 s user-facing
-- PGRST002 burst for nothing — LEAVE IT UNAPPLIED. `migration-parity` matches
-- applied -> file BY NAME, so committing this file is what closes the gap.
--
-- WHAT CHANGED IN PRODUCTION, AND WHY
--
-- One word: `now()` -> `clock_timestamp()` for the `finished_at` value.
--
-- `pipeline_runs.duration_ms` is a GENERATED column over (finished_at -
-- started_at), GREATEST-clamped at 0. Callers pass `p_started_at :=
-- clock_timestamp()` captured at their own entry — a real wall-clock reading
-- taken DURING the transaction. `now()` is transaction START, which is always
-- EARLIER. So finished_at < started_at on every call, the clamp fired, and
-- `duration_ms` was a structural hard 0 for ten pipelines.
--
-- ⚠ THE COST WAS NOT THE TYPO, IT WAS THE BLINDNESS. Within minutes of the fix,
-- `pack-ask-hourly-low-roll` reported **37,849 ms** and `promote_unmapped_sales`
-- **78,443 ms** where both had logged 0 forever. Both run frequently, and both
-- were invisible to every duration-ranked board, arm and triage — including every
-- attempt this month to work out what saturates this instance. Detail:
-- docs/overnight/inbox/2026-08-23T1910Z-pipeline-runs-duration-ms-was-structurally-zero-for-ten-pipelines.md
--
-- ⚠ HISTORY IS NOT RECOVERABLE for nine of the ten — the pre-fix rows simply do
-- not carry the information. `series-detail-rollup` is the exception: it also
-- writes its own `duration_ms` inside `extra`, so read `extra->>'duration_ms'`
-- there, never the column, for anything before this migration.
--
-- ⚠ THE 3-ARG OVERLOAD (p_pipeline, p_ok, p_extra) IS UNTOUCHED and does not need
-- touching: it passes `p_started_at := now()`, so its finished_at is now at worst
-- microseconds later than its started_at rather than exactly equal. Strictly
-- better, no caller change.
--
-- anon-exec: unchanged — log_pipeline_run is SECURITY DEFINER and is already
-- revoked from PUBLIC, anon and authenticated. Verified live 2026-08-23 with
-- has_function_privilege (not the acl text) for BOTH overloads: anon=false,
-- authenticated=false, service_role=true. ⚠ A REVOKE must NOT be added here:
-- `CREATE OR REPLACE FUNCTION` does not reset a function's ACL, so a revoke in a
-- byte-identical snapshot would CHANGE production while presenting itself as a
-- no-op.

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

-- >>> BEGIN revert >>>
-- Restores the pre-2026-08-23 body (finished_at := now()). ⚠ Reverting
-- re-instates the structural zero in pipeline_runs.duration_ms for every caller
-- that passes clock_timestamp() as p_started_at — which is all ten.
--
-- CREATE OR REPLACE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamp with time zone, p_rows_found integer DEFAULT 0, p_rows_written integer DEFAULT 0, p_rows_skipped integer DEFAULT 0, p_ok boolean DEFAULT true, p_error text DEFAULT NULL::text, p_collection_slug text DEFAULT NULL::text, p_cursor_before text DEFAULT NULL::text, p_cursor_after text DEFAULT NULL::text, p_extra jsonb DEFAULT NULL::jsonb)
--  RETURNS bigint
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
-- DECLARE
--   v_id bigint;
-- BEGIN
--   INSERT INTO public.pipeline_runs (
--     pipeline, collection_slug, started_at, finished_at,
--     rows_found, rows_written, rows_skipped,
--     cursor_before, cursor_after, ok, error, extra
--   ) VALUES (
--     p_pipeline, p_collection_slug, p_started_at, now(),
--     COALESCE(p_rows_found,0), COALESCE(p_rows_written,0), COALESCE(p_rows_skipped,0),
--     p_cursor_before, p_cursor_after, p_ok, p_error, p_extra
--   )
--   RETURNING id INTO v_id;
--
--   RETURN v_id;
-- END;
-- $function$;
-- <<< END revert <<<
