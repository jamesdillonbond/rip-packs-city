-- CLOSES THE BLIND SPOT INTRODUCED BY MATERIALIZING PUBLIC BOARDS (2026-08-01/02).
--
-- Three public boards were materialized today for real wins
-- (perfect-mint 16,992ms -> 1.5ms, pack-reality 9,798ms -> 0.14ms, market-index
-- 5,809ms -> 0.46ms). But an MV changes the failure MODE: a dead refresh reads as
-- PLAUSIBLE, STALE DATA rather than as an error — and both board-liveness arms are
-- blind to it, because a stale MV still returns plenty of rows, fast.
--
-- `check_pgcron_recent_failures()` catches a refresh that RUNS AND FAILS. It cannot
-- catch a refresh that is never SCHEDULED — an unscheduled job has no run rows to
-- fail. That is the residual exposure, and it is the same shape as the 08-01
-- precedent.
--
-- This arm closes both cases at once by measuring the OUTCOME (how long since a
-- successful refresh) rather than the mechanism: an unscheduled job, a deactivated
-- job, a dropped job and a persistently-failing job all stop the clock identically.
CREATE TABLE IF NOT EXISTS public.board_mv_refresh_watchlist (
  matview_name   text PRIMARY KEY,
  max_stale_hours numeric NOT NULL,
  is_active      boolean NOT NULL DEFAULT true,
  note           text
);
ALTER TABLE public.board_mv_refresh_watchlist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.board_mv_refresh_watchlist FROM anon, authenticated;

INSERT INTO public.board_mv_refresh_watchlist (matview_name, max_stale_hours, note) VALUES
  ('mv_topshot_market_index_daily',         6, 'backs /insights/market; pg_cron rpc-refresh-market-index-daily 7 * * * * (hourly) -> 6h = 6 missed ticks'),
  ('mv_topshot_perfect_mint_premiums_board',6, 'backs /insights/perfect-mint-premiums; pg_cron rpc-refresh-perfect-mint-premiums 17 * * * *'),
  ('mv_topshot_pack_reality_dist',          6, 'backs /insights/pack-reality; pg_cron rpc-refresh-pack-reality-dist 27 * * * *')
ON CONFLICT (matview_name) DO NOTHING;

-- Hours since the last SUCCESSFUL refresh of each watchlisted MV, read from
-- cron.job_run_details. A never-scheduled MV yields NULL -> 999 -> breach, which is
-- the whole point: an unscheduled refresh must be LOUD, not silently green.
CREATE OR REPLACE FUNCTION public.board_mv_refresh_max_stale_hours()
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'cron'
AS $fn$
  SELECT COALESCE(max(stale_h), 0)::numeric
  FROM (
    SELECT COALESCE(
             EXTRACT(epoch FROM (now() - (
               SELECT max(d.end_time)
                 FROM cron.job j
                 JOIN cron.job_run_details d ON d.jobid = j.jobid
                WHERE j.active
                  AND d.status = 'succeeded'
                  AND j.command ILIKE '%' || w.matview_name || '%'
             ))) / 3600.0,
             999
           ) AS stale_h
      FROM public.board_mv_refresh_watchlist w
     WHERE w.is_active
  ) s;
$fn$;
REVOKE EXECUTE ON FUNCTION public.board_mv_refresh_max_stale_hours() FROM PUBLIC, anon, authenticated;

-- Add the arm. Guarded splice that ABORTS on anchor drift.
DO $mig$
DECLARE
  src text; out_src text;
  anchor CONSTANT text := E'        UNION ALL\n         SELECT \'unmapped_resolution_backlog_max\'::text AS text,';
  arm CONSTANT text :=
E'        UNION ALL\n         SELECT \'board_mv_refresh_stale_hours\'::text AS text,\n            public.board_mv_refresh_max_stale_hours() AS "coalesce",\n            8::numeric AS "numeric",\n            \'a MATERIALIZED public board serving stale data. Three boards were materialized 2026-08-01/02 for real wins (perfect-mint 16,992ms->1.5ms, pack-reality 9,798ms->0.14ms, market-index 5,809ms->0.46ms), but an MV changes the FAILURE MODE: a dead refresh reads as plausible stale data, and BOTH board-liveness arms are blind to it because a stale MV still returns plenty of rows, fast. check_pgcron_recent_failures() catches a refresh that RUNS AND FAILS but CANNOT catch one that is never SCHEDULED (no run rows to fail). This measures the OUTCOME - hours since the last SUCCESSFUL refresh - so unscheduled, deactivated, dropped and persistently-failing all stop the clock identically. All three jobs are hourly, so 8h = 8 missed ticks; a never-scheduled MV yields 999 and breaches immediately, because an unscheduled refresh must be LOUD not silently green.\'::text AS text\n' || anchor;
BEGIN
  SELECT pg_get_viewdef('public.v_rpc_trust_health'::regclass, true) INTO src;
  IF position(anchor in src) = 0 THEN
    RAISE EXCEPTION 'anchor not found — aborting, nothing changed';
  END IF;
  IF position('board_mv_refresh_stale_hours' in src) > 0 THEN
    RAISE NOTICE 'arm already present — skipping'; RETURN;
  END IF;
  out_src := replace(src, anchor, arm);
  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || out_src;
  EXECUTE 'ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on)';
END
$mig$;