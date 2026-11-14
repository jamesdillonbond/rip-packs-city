-- 2026-11-14 (Claude Code cloud, ~2:17 PM PT) — inbox 2026-11-14T2211Z (daytime monitor).
--
-- 20261114212002 repointed pg_cron `rpc-refresh-perfect-mint-premiums` from a bare
-- `REFRESH … mv_topshot_perfect_mint_premiums_board` to `SELECT public.refresh_topshot_perfect_mint_premiums_board()`.
-- board_mv_refresh_max_stale_hours() finds each watchlisted MV's job by `command ILIKE '%'||matview_name||'%'`,
-- and the wrapper's name lacks the `mv_` prefix, so the join missed, fell back to `watchlisted_at`
-- (2026-08-02) and the trust-health metric read a permanent false BREACH of 2502.9 h — which would have
-- hidden a real perfect-mint board-down behind a standing alarm. Smallest fix (the filing's option 2):
-- the command names its MV in a block comment (one statement; a comment is not a prefix).
--
-- Read back: board_mv_refresh_stale_hours 2502.9 h BREACH → 1.79 h ok; the exact command text run once by
-- hand logged ok / 43 rows (22:17Z). The metric's own logic is unchanged, so its existing down-detection
-- (a deactivated or dropped job) still applies; not re-exercised by deactivating 236 in production.
--
-- Revert: SELECT cron.alter_job(jobid, command := 'SELECT public.refresh_topshot_perfect_mint_premiums_board()')
--           FROM cron.job WHERE jobname = 'rpc-refresh-perfect-mint-premiums';   (brings the false BREACH back)
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'rpc-refresh-perfect-mint-premiums';
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected exactly one rpc-refresh-perfect-mint-premiums job, found %', v_n; END IF;
  PERFORM cron.alter_job(jobid,
    command := 'SELECT public.refresh_topshot_perfect_mint_premiums_board() /* refreshes mv_topshot_perfect_mint_premiums_board — board_mv_refresh_max_stale_hours() finds its job by this name */')
     FROM cron.job WHERE jobname = 'rpc-refresh-perfect-mint-premiums';
END $$;
