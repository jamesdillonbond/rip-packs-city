-- audit_20260802_board_mv_watchdog_no_false_breach_on_new_row
--
-- PROBLEM. board_mv_refresh_max_stale_hours() returned the sentinel 999 for any
-- watchlisted MV with no *successful* cron refresh yet. A board that is materialized
-- and watchlisted between two ticks of its own refresh job therefore reads 999 against
-- breach_at 8 -- an instant BREACH -- for up to a full hour, while the MV is freshly
-- populated and the board is fast and correct.
--
-- Observed 2026-08-02: audit_20260802_candy_holder_board_materialize landed 14:55:36Z;
-- its pg_cron job (rpc-refresh-candy-holder-board, '47 * * * *') had not yet reached
-- its first :47 slot, so cron.job_run_details held zero rows for it and the metric read
-- 999 while mv_candy_holder_board held 407 correct rows and the board answered in 38 ms
-- (down from 16,626 ms). Same false-positive class as detect_stalled_pipelines() firing
-- on last_run IS NULL -- the reason the 2026-08-01 pipeline watchlist rows were inserted
-- is_active=false and armed only once real runs existed.
--
-- FIX. Measure staleness from the last successful refresh, falling back to WHEN THE ROW
-- ENTERED THE WATCHLIST rather than to a sentinel. A genuinely dead or misnamed refresh
-- job still breaches -- on a real, growing number, once it has had the same 8h the
-- already-established rows get -- so the tripwire is preserved, not widened. What is
-- removed is only the ability to fire before the job has had a chance to run once.
-- Proven still-biting: the same fallback arm evaluated against a row watchlisted 20h ago
-- with no successful refresh reads 20.00 (> breach_at 8).
--
-- REVERT:
--   CREATE OR REPLACE FUNCTION public.board_mv_refresh_max_stale_hours()
--    RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','cron'
--   AS $$
--     SELECT COALESCE(max(stale_h), 0)::numeric
--     FROM (
--       SELECT COALESCE(
--                EXTRACT(epoch FROM (now() - (
--                  SELECT max(d.end_time) FROM cron.job j
--                    JOIN cron.job_run_details d ON d.jobid = j.jobid
--                   WHERE j.active AND d.status = 'succeeded'
--                     AND j.command ILIKE '%' || w.matview_name || '%'))) / 3600.0,
--                999) AS stale_h
--         FROM public.board_mv_refresh_watchlist w WHERE w.is_active) s;
--   $$;
--   ALTER TABLE public.board_mv_refresh_watchlist DROP COLUMN watchlisted_at;

ALTER TABLE public.board_mv_refresh_watchlist
  ADD COLUMN IF NOT EXISTS watchlisted_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN public.board_mv_refresh_watchlist.watchlisted_at IS
  'When this MV entered the watchdog. Used as the staleness baseline until its refresh job records its first success, so a newly materialized board cannot manufacture an instant breach. New rows get now() by default -- do not backdate it.';

-- The only row without a successful refresh at migration time. Its true insertion was
-- 2026-08-02 14:55:36Z (audit_20260802_candy_holder_board_materialize); the ADD COLUMN
-- default would have stamped it ~30 min late and given it that much extra grace.
UPDATE public.board_mv_refresh_watchlist
   SET watchlisted_at = timestamptz '2026-08-02 14:55:36+00'
 WHERE matview_name = 'mv_candy_holder_board';

CREATE OR REPLACE FUNCTION public.board_mv_refresh_max_stale_hours()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'cron'
AS $function$
  SELECT COALESCE(max(stale_h), 0)::numeric
  FROM (
    SELECT EXTRACT(epoch FROM (now() - COALESCE(
             (SELECT max(d.end_time)
                FROM cron.job j
                JOIN cron.job_run_details d ON d.jobid = j.jobid
               WHERE j.active
                 AND d.status = 'succeeded'
                 AND j.command ILIKE '%' || w.matview_name || '%'),
             -- No successful refresh yet: age from when the board was watchlisted, so a
             -- job that has genuinely never fired still grows into a breach on its own.
             w.watchlisted_at
           ))) / 3600.0 AS stale_h
      FROM public.board_mv_refresh_watchlist w
     WHERE w.is_active
  ) s;
$function$;
