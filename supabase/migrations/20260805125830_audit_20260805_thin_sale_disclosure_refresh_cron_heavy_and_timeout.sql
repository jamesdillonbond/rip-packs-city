-- 2026-08-05 · Fix two defects in audit_20260805_thin_sale_ask_disclosure_cache.
--
-- The first cron tick FAILED: 09:10:00.435 -> 09:12:00.439, exactly 120s,
-- "canceling statement due to statement timeout" on the INSERT. Two causes, both mine:
--
--   1. WRONG ROLE. I scheduled the job as `postgres`. Every other heavy job in this
--      database runs as `cron_heavy`, which carries an explicit statement_timeout=600s
--      (rpc-trust-health-precompute-refresh jobid 222, rpc-fmv-clamp-disconnected-ask
--      jobid 69). `postgres` has no entry in pg_db_role_setting but was cancelled at
--      exactly 2 minutes, i.e. a platform default the function-level SET did not beat.
--      I invented a pattern instead of copying the one already in the database.
--
--   2. MISSING GRANT. EXECUTE was granted to service_role only -- so even re-pointed at
--      cron_heavy the job would have failed on permissions. And service_role carries
--      statement_timeout=30s, so a service_role caller could never have run this at all.
--
-- Belt and braces: the body now sets its own timeout via set_config() as its first
-- action, which applies unambiguously regardless of how the caller was configured.
-- proconfig raised 300s -> 900s to match; the view has exceeded 60s and 120s under
-- real conditions, so its true cost is not yet bounded and the budget should not be
-- the thing that fails first.
--
-- Schedule moved 09:10 -> 09:25 for clear separation from the clamp (jobid 69, 08:55,
-- 120s budget), which performs the same expensive 90-day sales aggregate.
--
-- REVERT: SELECT cron.unschedule('rpc-thin-sale-ask-disclosure-refresh');
--         plus DROP FUNCTION / DROP TABLE from the parent migration.

CREATE OR REPLACE FUNCTION public.fmv_thin_sale_ask_disclosure_refresh()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '900s'
AS $function$
DECLARE
  t0 timestamptz := clock_timestamp();
  v_rows bigint;
BEGIN
  -- Applies to this transaction regardless of the caller's configured timeout.
  -- The first scheduled run died at exactly 120s despite proconfig saying 300s.
  PERFORM set_config('statement_timeout', '900s', true);

  -- Single transaction: the table is never observed empty by a concurrent reader.
  DELETE FROM public.fmv_thin_sale_ask_disclosure_cache;

  INSERT INTO public.fmv_thin_sale_ask_disclosure_cache
  SELECT v.*, now()
  FROM public.v_fmv_thin_sale_ask_disclosure v;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- A zero-row result is REAL (the clamp could legitimately drain the cohort), but it
  -- is also what a broken upstream looks like, so it is reported rather than silent.
  RETURN jsonb_build_object(
    'rows', v_rows,
    'duration_ms', round(EXTRACT(epoch FROM clock_timestamp() - t0) * 1000),
    'refreshed_at', now()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fmv_thin_sale_ask_disclosure_refresh() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fmv_thin_sale_ask_disclosure_refresh() TO service_role, cron_heavy;

COMMENT ON FUNCTION public.fmv_thin_sale_ask_disclosure_refresh() IS
  'Repopulates fmv_thin_sale_ask_disclosure_cache from v_fmv_thin_sale_ask_disclosure. Reads THE VIEW, never a copy of its predicate, so the disclosure cannot drift from the clamp it describes. Expensive and not yet bounded (>120s observed); runs under cron_heavy. Do NOT call from an MCP client -- the 60s client timeout rolls it back, and service_role caps at 30s.';
