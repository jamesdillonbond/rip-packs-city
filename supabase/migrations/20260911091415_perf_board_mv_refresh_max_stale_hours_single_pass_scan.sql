-- perf_board_mv_refresh_max_stale_hours_single_pass_scan
--
-- WHY. board_mv_refresh_max_stale_hours() ran a CORRELATED subquery once per
-- active watchlisted MV (8 today), and each one is a Parallel Seq Scan of
-- cron.job_run_details -- 261,934 rows / 154 MB, oldest 2026-07-09, carrying ONLY
-- a `runid` pkey, so there is no jobid index to use. Measured with the SAME
-- instrument on 2026-09-11 (BUFFERS, not wall-clock, because this instance's
-- saturation confounds timings in both directions):
--
--     OLD  shared hit=576 read=150601   (Seq Scan on job_run_details, loops=8)
--     NEW  shared hit=174 read=18759    (one scan, via a MATERIALIZED CTE)
--
-- an 8.0x reduction in physical reads, exactly the 8-loops -> 1 prediction. On a
-- disk-IO-budgeted Small instance that leg intermittently pushed
-- rpc_ops_snapshot() and the live v_rpc_trust_health board-MV arm past the ~120 s
-- gateway cap (57014). ⚠ The timeout is LOAD-DEPENDENT and was NOT reproducible
-- on demand when this shipped -- the old form completed in 970 ms on a warm
-- cache. This is justified on the buffer reduction, which is the durable signal;
-- do not go looking for a reproducible timeout to "confirm" it.
--
-- ⚠ AN INDEX WAS THE FIRST CHOICE AND IS BLOCKED: CREATE INDEX ... ON
-- cron.job_run_details (jobid, status, end_time) fails `42501 must be owner of
-- table job_run_details` -- the table is pg_cron-owned. Hence a value-equivalent
-- rewrite rather than an index.
--
-- EQUIVALENCE IS PROVEN OVER THE POPULATION, not argued from the plan: both
-- forms were run side by side per watchlist row on 2026-09-11 and returned the
-- IDENTICAL last_end for all 8 active MVs (IS NOT DISTINCT FROM, so NULLs count
-- as equal). max() over a union of groups == max() of the per-group maxes, which
-- is why the pre-aggregation is safe.
--
-- anon-exec: unchanged -- board_mv_refresh_max_stale_hours is ALREADY revoked in
-- prod (verified 2026-09-11 with has_function_privilege, not acl text: anon
-- EXECUTE false, authenticated EXECUTE false, service_role true; and
-- check_secdef_anon_exec_drift() length 0). CREATE OR REPLACE does NOT reset a
-- function's ACL, so adding a REVOKE here would change production while
-- pretending to be a body-only rewrite. (board_mv_refresh_max_stale_hours)
--
-- DURABLE COMPANION, NOT DONE HERE: cron.job_run_details has no retention at all
-- (261,934 rows / 2 months). A prune is the real long-term lever and would fix
-- this class rather than this instance -- but it is a bulk DELETE on a
-- pg_cron-owned table, so it is destructive and needs an operator decision.
--
-- REVERT: re-apply the body from 20260802152023 (the correlated-subquery form,
-- /3600.0, COALESCE to w.watchlisted_at).
-- VERIFY AFTER: SELECT rpc_ops_snapshot() completes; SELECT * FROM
-- v_rpc_trust_health WHERE status <> 'ok' returns without timing out; the value
-- still matches the pre-change reading (2.11 +/- normal drift).
CREATE OR REPLACE FUNCTION public.board_mv_refresh_max_stale_hours()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'cron'
AS $function$
  WITH last_ok AS MATERIALIZED (
    SELECT jobid, max(end_time) AS last_end
    FROM cron.job_run_details
    WHERE status = 'succeeded'
    GROUP BY jobid
  )
  SELECT COALESCE(max(stale_h), 0)::numeric
  FROM (
    SELECT EXTRACT(epoch FROM (now() - COALESCE(
             (SELECT max(l.last_end)
                FROM cron.job j
                JOIN last_ok l ON l.jobid = j.jobid
               WHERE j.active
                 AND j.command ILIKE '%' || w.matview_name || '%'),
             -- No successful refresh yet: age from when the board was watchlisted, so a
             -- job that has genuinely never fired still grows into a breach on its own.
             w.watchlisted_at
           ))) / 3600.0 AS stale_h
      FROM public.board_mv_refresh_watchlist w
     WHERE w.is_active
  ) s;
$function$;