-- audit_20260913_a_nightly_big_wallet_lane_refreshes_the_saved_wallets_the_hourly_gate_skips
--
-- ── WHY ────────────────────────────────────────────────────────────────────────
-- `20260913211500` gave the hourly saved-wallet sweep a size gate (p_max_moments,
-- default 20,000) after one 44,646-moment wallet at the head of the stalest-first
-- queue killed the CALL at the global 120 s budget seven ticks running. The gate
-- keeps the sweep alive, and the 2:44 PM and 3:44 PM PT ticks proved it; but the
-- two saved wallets above it (44,646 and 34,860 cached moments, register #111)
-- are real users whose portfolio figures would otherwise never refresh again.
--
-- ── WHAT CHANGED SINCE THE GATE, MEASURED (2026-09-13 4:0x PM PT, quiet) ───────
-- `idx_wmc_wallet_coll_ek_fmv_tier` (20260913231800) makes the aggregate's
-- wallet_moments_cache leg index-only. The whale's aggregate, warm:
--   generic-plan shape (what the procedure's 6th+ call gets):
--     356,328 buffers / 24.2 s  ->  33,176 buffers / 194 ms   (hash joins now)
--   custom-plan shape (address known):
--      40,360 buffers /  6.6 s  ->  33,212 buffers / 1.15 s
-- Heap Fetches 17.9k of 44.6k remain (pages not all-visible: the 10-minute FMV
-- refresh keeps unsetting bits), so under a saturation spell this wallet can
-- still cost tens of seconds of random reads. That is why the gate STAYS on the
-- hourly lane and the whales get their own lane at a quiet hour instead.
--
-- ── THE LANE ───────────────────────────────────────────────────────────────────
-- One CALL a day at 3:51 AM PT (10:51Z). No minute is free of the 2-minute Atlas
-- drains; :51 was chosen from `cron.job` because at hour 10 it carries only those
-- plus three light lanes, none of which writes saved_wallets or
-- wallet_moments_cache (:52 has the hourly parallel-identity sync, :53 the sales
-- partition VACUUM, :55 the wmc hydrate), and it is off the hourly lane's :44 so
-- the two never hold saved_wallets row locks against each other — the 08-29
-- collision lesson. Same procedure,
-- same logging pipeline name (`reconcile-saved-wallet-stats`), p_max_moments
-- raised to 100,000 so both wallets above the hourly gate are attempted; the
-- p_min_age gate (360 min) is unchanged, so on a night the hourly lane has
-- already refreshed everything the CALL finds nothing due and logs that. The
-- soft deadline is 110 s under the 120 s global statement budget the `postgres`
-- job role carries; a single aggregate is not bounded by it, which the numbers
-- above make acceptable at 3:52 AM and would not at 2 PM.
--
-- REVERT: SELECT cron.unschedule('rpc-reconcile-saved-wallet-stats-big');

SELECT cron.schedule(
  'rpc-reconcile-saved-wallet-stats-big',
  '51 10 * * *',
  $$CALL public.reconcile_all_saved_wallet_stats(110, 40, 360, 100000);$$
);
