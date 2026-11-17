-- Hourly CONCURRENTLY refresh for mv_topshot_perfect_mint_premiums_board.
-- CONCURRENTLY (not a plain REFRESH) so the ~17s rebuild never takes an
-- ACCESS EXCLUSIVE lock that would hang the public board for its duration.
-- Minute 17 keeps it off the :07 market-index refresh and the :23/:53 pack crons.
--
-- REVERT: SELECT cron.unschedule('rpc-refresh-perfect-mint-premiums');
SELECT cron.schedule(
  'rpc-refresh-perfect-mint-premiums',
  '17 * * * *',
  'REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_perfect_mint_premiums_board'
);