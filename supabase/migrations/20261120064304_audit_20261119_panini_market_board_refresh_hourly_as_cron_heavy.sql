-- audit_20261119_panini_market_board_refresh_hourly_as_cron_heavy — the refresher runs hourly under cron_heavy.
--
-- The second scheduled tick of rpc-panini-market-board (jobid 896, postgres, 2026-11-19 10:37 PM PT)
-- took 83.7 s: the aggregate behind the copy is the same cold read that passed the route's 8 s bound,
-- and a job owned by postgres is cancelled at 120 s. Two changes: the job is re-created under
-- cron_heavy (statement_timeout 600 s; it reaches the copy only through the SECURITY DEFINER
-- refresher) and runs hourly at :37 instead of every 30 min — Panini asks are walk-confirmed over
-- days and the board keeps one for 7. /api/market falls back to the live view when the copy is
-- older than 3 h (two missed ticks and then some).
--
-- anon-exec: unchanged (refresh_panini_market_board) — no body change; EXECUTE additionally granted to cron_heavy, anon/authenticated stay revoked (has_function_privilege anon = false, read 2026-11-19).
--
-- Revert: SET ROLE cron_heavy; SELECT cron.unschedule('rpc-panini-market-board'); RESET ROLE;
--         SELECT cron.schedule('rpc-panini-market-board', '7,37 * * * *', $$SELECT public.refresh_panini_market_board()$$);

GRANT EXECUTE ON FUNCTION public.refresh_panini_market_board() TO cron_heavy;

DO $do$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'rpc-panini-market-board' AND username = 'postgres';
  IF v_n <> 1 THEN RAISE EXCEPTION 'rpc-panini-market-board: expected one postgres-owned job, found %', v_n; END IF;
  PERFORM cron.unschedule('rpc-panini-market-board');
  SET LOCAL ROLE cron_heavy;
  PERFORM cron.schedule('rpc-panini-market-board', '37 * * * *', $$SELECT public.refresh_panini_market_board()$$);
  RESET ROLE;
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'rpc-panini-market-board' AND username = 'cron_heavy' AND active AND schedule = '37 * * * *';
  IF v_n <> 1 THEN RAISE EXCEPTION 'rpc-panini-market-board: not re-created under cron_heavy (found %)', v_n; END IF;
END
$do$;

COMMENT ON MATERIALIZED VIEW public.mv_panini_market_board IS
  'Stored copy of panini_market_board (audit_20261119) + computed_at, refreshed hourly (:37) by pg_cron rpc-panini-market-board under cron_heavy. Read by /api/market (Panini arm), which falls back to the live view when computed_at is older than 3 h. service_role only.';
