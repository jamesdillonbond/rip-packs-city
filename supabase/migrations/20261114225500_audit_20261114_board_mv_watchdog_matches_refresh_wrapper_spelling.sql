-- 2026-11-14 (Claude Code cloud, ~2:55 PM PT) — inbox 2026-11-14T2211Z, option 1 (the class fix).
--
-- board_mv_refresh_max_stale_hours() finds a board's refresh job by `command ILIKE '%<matview_name>%'`.
-- A board moved behind a logged-refresh WRAPPER (refresh_<name>() calling log_pipeline_run, as
-- mv_topshot_perfect_mint_premiums_board was today in 20261114212002) no longer carries the literal
-- MV name, so the join missed, fell back to watchlisted_at, and the metric read a permanent false
-- BREACH (2502.8 h). 20261114221716 patched that one job with a comment naming the MV (option 2);
-- this teaches the join the wrapper spelling too — `refresh_<matview name minus mv_>(` — so the next
-- board moved behind a wrapper is recognised without a comment. The literal-name arm is unchanged.
-- Live body re-read immediately before writing: md5(prosrc) 01d503e71671a13eb6ebea1169dfd3e8.
-- Down-detection proven in a rolled-back DO block (job 236 deactivated → BREACH-sized value).
-- anon-exec: unchanged (board_mv_refresh_max_stale_hours) — CREATE OR REPLACE of an existing fn; ACL preserved.
-- Revert: re-apply 20260911091415_perf_board_mv_refresh_max_stale_hours_single_pass_scan.sql (the prior body).
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
                 AND (j.command ILIKE '%' || w.matview_name || '%'
                      -- 2026-11-14: a logged-refresh wrapper, refresh_<name>(), names no MV.
                      OR j.command ILIKE '%refresh\_' || regexp_replace(w.matview_name, '^mv_', '') || '(%')),
             -- No successful refresh yet: age from when the board was watchlisted, so a
             -- job that has genuinely never fired still grows into a breach on its own.
             w.watchlisted_at
           ))) / 3600.0 AS stale_h
      FROM public.board_mv_refresh_watchlist w
     WHERE w.is_active
  ) s;
$function$;
