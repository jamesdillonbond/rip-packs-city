-- audit_20260913_a_nightly_big_wallet_lane_refreshes_the_saved_wallets_the_hourly_gate_skips
-- (rationale in the committed file of the same name)
-- REVERT: SELECT cron.unschedule('rpc-reconcile-saved-wallet-stats-big');

SELECT cron.schedule(
  'rpc-reconcile-saved-wallet-stats-big',
  '51 10 * * *',
  $$CALL public.reconcile_all_saved_wallet_stats(110, 40, 360, 100000);$$
);