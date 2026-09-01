-- audit_20260901_ops_pgss_snapshot_scheduled_and_delta_reader
-- anon-exec: ops_pgss_snapshot — service_role/postgres only; EXECUTE revoked from PUBLIC, anon, authenticated below.
-- anon-exec: ops_pgss_delta — service_role/postgres only; EXECUTE revoked from PUBLIC, anon, authenticated below.
--
-- WHY (decided 2026-09-01, closing the "audit_20260830_pgss_snap lifecycle" question).
--
-- The pg_stat_statements leaderboard STRADDLES every fix since its 2026-08-12 reset, so an
-- 18.9-day aggregate still ranked panini_squeeze_board at 374 GB months after the board started
-- EXPLAINing at 5 ms / 290 buffers. The delta against a snapshot is the honest instrument, and it
-- already exists as public.audit_20260830_pgss_snap. Two things were wrong with it:
--
--   1. IT WAS SESSION-DRIVEN, NOT SCHEDULED — no cron.job row. 26 snapshots in 37 h with gaps up
--      to 4 h, so a pass computing a "2-hour window" could silently be computing a 4-hour one and
--      would not know. Filed 2026-09-01: "the instance's top consumer was misattributed for four
--      passes." Four passes is the measured cost of an instrument nobody scheduled.
--   2. THE DIFF WAS HAND-WRITTEN EVERY TIME. Each pass re-wrote the join on
--      (queryid, toplevel, userid, dbid) from memory, which is where the misattribution entered.
--      A counter RESET or a pgss eviction makes live.calls < baseline.calls, and a hand-written
--      subtraction turns that into a large NEGATIVE delta that sorts to the bottom and disappears,
--      or (worse) an unsigned wrap that sorts to the top. Neither reads as "I cannot answer".
--
-- WHAT SHIPS
--   * ops_pgss_snapshot()  — takes one snapshot and prunes beyond the retention horizon.
--   * ops_pgss_delta()     — the reader. Picks the newest snapshot AT OR BEFORE now()-lookback
--                            (never the newest overall, which is minutes old and would report a
--                            near-zero window), RETURNS the baseline's real age so the caller can
--                            never mistake a 4-hour window for a 2-hour one, and marks
--                            counter_reset = true instead of emitting a bogus delta.
--   * cron job rpc-pgss-snapshot, '5 */2 * * *' — 2-hourly at :05, which is 13 min before the
--     :18 autonomous pass and 53 min before the :58 one. Both therefore find a baseline that is
--     ~2 h old (the SECOND-newest snapshot), which is the window they actually want.
--
-- RANKING IS BY DISK READS, NOT TIME: on a 2 GB IOPS-budgeted instance, shared_blks_read is the
-- scarce resource and total_exec_time is contaminated by lock waits and concurrency. Time is
-- returned alongside, not sorted on.
--
-- COST + RETENTION. pg_stat_statements holds 4,857 live rows, so a snapshot is ~4.9k rows and the
-- table is 44 MB at 26 snapshots. At 12 snapshots/day, 4 days of retention is ~233k rows / ~80 MB
-- steady-state — bounded, and the prune runs inside the same job so retention cannot drift from
-- the cadence. 4 days is deliberate: long enough to compare a pass against the same hour two days
-- earlier, short enough to stay inside the cost-flat gate.
--
-- ⚠ THE TABLE IS NOT DISPOSABLE DESPITE ITS NAME. audit_20260830_pgss_snap keeps its name because
-- renaming it would break every in-flight session and scheduled-task prompt that names it; the
-- COMMENT below is the durable record that it is now a scheduled instrument, not one pass's
-- scratch table. Read it through ops_pgss_delta() rather than by hand.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-pgss-snapshot');
--   DROP FUNCTION public.ops_pgss_delta(interval, integer);
--   DROP FUNCTION public.ops_pgss_snapshot(integer);
--   (the table and its existing rows are left alone by this migration's revert on purpose)

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
  FROM pg_stat_statements s
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

REVOKE ALL ON FUNCTION public.ops_pgss_snapshot(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ops_pgss_snapshot(integer) TO service_role;

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
    FROM pg_stat_statements p
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

REVOKE ALL ON FUNCTION public.ops_pgss_delta(interval, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ops_pgss_delta(interval, integer) TO service_role;

COMMENT ON TABLE public.audit_20260830_pgss_snap IS
  'SCHEDULED INSTRUMENT — NOT a disposable audit_ scratch table despite the name. Written every 2h '
  'at :05 by cron job rpc-pgss-snapshot -> public.ops_pgss_snapshot(), retained 4 days. It is the '
  'baseline for public.ops_pgss_delta(), the only honest ranking of DB consumers on this instance: '
  'the raw pg_stat_statements leaderboard straddles every fix since its 2026-08-12 reset. '
  'Do not drop it in an audit_-prefix cleanup. Read it through ops_pgss_delta(), not by hand — '
  'hand-written joins on (queryid,toplevel,userid,dbid) misattributed the top consumer for four '
  'consecutive passes because they had no counter-reset case.';

DO $mig$
DECLARE
  v_jobid bigint;
BEGIN
  PERFORM cron.unschedule('rpc-pgss-snapshot')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-pgss-snapshot');

  SELECT cron.schedule('rpc-pgss-snapshot', '5 */2 * * *', 'SELECT public.ops_pgss_snapshot(4)')
    INTO v_jobid;

  IF NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'rpc-pgss-snapshot' AND active
  ) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: rpc-pgss-snapshot not scheduled';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('ops_pgss_snapshot','ops_pgss_delta')
    GROUP BY 1 HAVING count(*) = 0
  ) AND (
    SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('ops_pgss_snapshot','ops_pgss_delta')
  ) <> 2 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: expected both ops_pgss_* functions';
  END IF;

  IF has_function_privilege('anon', 'public.ops_pgss_delta(interval, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.ops_pgss_snapshot(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: anon can execute an ops_pgss_* function';
  END IF;
END
$mig$;