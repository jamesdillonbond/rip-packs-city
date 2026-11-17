-- audit_20260901_ops_pgss_functions_schema_qualify_pg_stat_statements
-- anon-exec: ops_pgss_snapshot — service_role/postgres only; the REVOKE from the parent migration stands (CREATE OR REPLACE preserves ACL, and this changes only the body).
-- anon-exec: ops_pgss_delta — service_role/postgres only; same, ACL unchanged.
--
-- WHY (measured minutes after 20260901_ops_pgss_snapshot_scheduled_and_delta_reader applied):
-- both functions carry `SET search_path TO 'public'`, which is correct hardening and is ALSO why
-- they could not see their own input. pg_stat_statements lives in the `extensions` schema on this
-- platform, not `public`, so the first live call failed with
--   ERROR 42P01: relation "pg_stat_statements" does not exist
-- The ad-hoc query that designed them succeeded only because an interactive session's search_path
-- happens to include `extensions`. That is the classic shape: the probe ran in a wider environment
-- than the thing it was a probe FOR.
--
-- ⚠ THE CRON JOB WOULD HAVE FAILED THE SAME WAY, SILENTLY. rpc-pgss-snapshot was scheduled by the
-- parent migration and its first fire is 05:05Z; a pg_cron failure lands in cron.job_run_details,
-- which nothing on this instance alerts on. The instrument would have read "scheduled" while
-- taking zero snapshots — the exact failure the parent migration exists to end.
--
-- FIX: schema-qualify the reference rather than widening search_path. `extensions.pg_stat_statements`
-- is explicit, survives any future search_path change, and keeps the hardened one-schema setting.
--
-- REVERT: CREATE OR REPLACE with the parent migration's bodies (unqualified) — which is broken, so
-- the real revert is the parent's: unschedule the job and drop both functions.

CREATE OR REPLACE FUNCTION public.ops_pgss_snapshot(p_retain_days integer DEFAULT 4)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_at        timestamptz := now();
  v_inserted  bigint := 0;
  v_pruned    bigint := 0;
BEGIN
  INSERT INTO public.audit_20260830_pgss_snap
    (at, userid, dbid, toplevel, queryid, calls, total_exec_time,
     shared_blks_read, shared_blks_hit, temp_blks_written, q)
  SELECT v_at, s.userid, s.dbid, s.toplevel, s.queryid, s.calls, s.total_exec_time,
         s.shared_blks_read, s.shared_blks_hit, s.temp_blks_written, LEFT(s.query, 2000)
  FROM extensions.pg_stat_statements s
  WHERE s.queryid IS NOT NULL;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  DELETE FROM public.audit_20260830_pgss_snap
  WHERE at < v_at - make_interval(days => GREATEST(p_retain_days, 1));
  GET DIAGNOSTICS v_pruned = ROW_COUNT;

  RETURN jsonb_build_object(
    'at', v_at,
    'rows_inserted', v_inserted,
    'rows_pruned', v_pruned,
    'retain_days', GREATEST(p_retain_days, 1),
    'snapshots_held', (SELECT count(DISTINCT at) FROM public.audit_20260830_pgss_snap)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ops_pgss_delta(
  p_lookback interval DEFAULT '2 hours'::interval,
  p_limit    integer  DEFAULT 25
)
RETURNS TABLE (
  baseline_at        timestamptz,
  baseline_age       interval,
  counter_reset      boolean,
  queryid            bigint,
  toplevel           boolean,
  d_shared_blks_read bigint,
  d_shared_blks_hit  bigint,
  d_calls            bigint,
  d_exec_ms          numeric,
  ms_per_call        numeric,
  q                  text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_base timestamptz;
BEGIN
  -- The newest snapshot AT OR BEFORE the requested look-back. Deliberately NOT the newest
  -- snapshot overall: at :18, minutes after the :05 job, that would be a 13-minute window
  -- reported as a 2-hour one. If nothing is old enough, fall back to the OLDEST snapshot held
  -- and let baseline_age say so rather than returning an empty set that reads as "no load".
  SELECT max(at) INTO v_base
  FROM public.audit_20260830_pgss_snap
  WHERE at <= now() - p_lookback;

  IF v_base IS NULL THEN
    SELECT min(at) INTO v_base FROM public.audit_20260830_pgss_snap;
  END IF;
  IF v_base IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT s.queryid, s.toplevel, s.userid, s.dbid,
           s.calls, s.total_exec_time, s.shared_blks_read, s.shared_blks_hit
    FROM public.audit_20260830_pgss_snap s
    WHERE s.at = v_base
  ),
  live AS (
    SELECT p.queryid, p.toplevel, p.userid, p.dbid,
           p.calls, p.total_exec_time, p.shared_blks_read, p.shared_blks_hit,
           LEFT(p.query, 2000) AS q
    FROM extensions.pg_stat_statements p
    WHERE p.queryid IS NOT NULL
  ),
  j AS (
    SELECT
      l.queryid, l.toplevel,
      -- A row absent from the baseline is NEW, not reset: its whole counter is the delta.
      -- A row whose live calls are BELOW the baseline means pg_stat_statements was reset or the
      -- entry was evicted and recreated — the subtraction is meaningless there, so it is flagged
      -- and the live counters are reported whole rather than silently emitting a negative.
      (b.queryid IS NOT NULL AND l.calls < b.calls)          AS reset,
      l.shared_blks_read - CASE WHEN b.queryid IS NULL OR l.calls < b.calls THEN 0 ELSE b.shared_blks_read END AS d_read,
      l.shared_blks_hit  - CASE WHEN b.queryid IS NULL OR l.calls < b.calls THEN 0 ELSE b.shared_blks_hit  END AS d_hit,
      l.calls            - CASE WHEN b.queryid IS NULL OR l.calls < b.calls THEN 0 ELSE b.calls            END AS d_calls,
      l.total_exec_time  - CASE WHEN b.queryid IS NULL OR l.calls < b.calls THEN 0 ELSE b.total_exec_time  END AS d_ms,
      l.q
    FROM live l
    LEFT JOIN base b
      ON  b.queryid  = l.queryid
      AND b.toplevel = l.toplevel
      AND b.userid   = l.userid
      AND b.dbid     = l.dbid
  )
  SELECT v_base,
         now() - v_base,
         j.reset,
         j.queryid,
         j.toplevel,
         j.d_read,
         j.d_hit,
         j.d_calls,
         round(j.d_ms::numeric, 1),
         CASE WHEN j.d_calls > 0 THEN round((j.d_ms / j.d_calls)::numeric, 2) END,
         j.q
  FROM j
  WHERE j.d_calls > 0 OR j.d_read > 0
  -- Disk reads, not time: shared_blks_read is the scarce resource on this instance, and
  -- total_exec_time is contaminated by lock waits and concurrency.
  ORDER BY j.d_read DESC, j.d_ms DESC
  LIMIT GREATEST(p_limit, 1);
END;
$function$;

DO $mig$
DECLARE
  v jsonb;
  v_rows int;
BEGIN
  -- POST-STATE IS A LIVE CALL, NOT A CATALOG READ. The defect this migration fixes was invisible
  -- to pg_proc and visible only on execution, so both functions are actually RUN here.
  SELECT public.ops_pgss_snapshot(4) INTO v;
  IF COALESCE((v->>'rows_inserted')::bigint, 0) < 1 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: ops_pgss_snapshot inserted no rows (%)', v;
  END IF;

  SELECT count(*) INTO v_rows FROM public.ops_pgss_delta('2 hours'::interval, 5);
  IF v_rows < 1 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: ops_pgss_delta returned no rows';
  END IF;
END
$mig$;