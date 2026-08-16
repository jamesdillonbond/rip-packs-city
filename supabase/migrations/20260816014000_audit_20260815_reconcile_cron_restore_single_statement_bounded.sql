-- audit_20260815 (PT) / 2026-08-16 UTC: repair rpc-reconcile-saved-wallet-stats (pg_cron jobid 259).
--
-- SYMPTOM: the nightly saved-wallet card refresh (backs dashboard / /profile / /share
-- cached_moment_count + cached_fmv_usd + cached_top_tier) FAILED on 08-14 (statement timeout)
-- and 08-15 (job startup timeout); last success 08-13. Cards drifted stale platform-wide
-- (42 wallets >24h, oldest 6.9 days at time of repair).
--
-- ROOT CAUSE: the job ran once daily (33 13 * * *) as `CALL ...reconcile_all_saved_wallet_stats()`
-- (defaults 50,500,360). The procedure commits per-wallet and has a 50s SOFT deadline, but that
-- deadline is only checked BETWEEN wallets. It runs as `postgres` under the GLOBAL 120s
-- statement_timeout, applied CUMULATIVELY across the whole CALL (internal COMMITs do NOT reset it
-- on this instance -- observed dying at exactly 120.0s). Under disk-IO saturation a single wallet's
-- aggregate takes 74-105s, so entering one late (e.g. at t~48s) straddles 120s -> hard abort with
-- zero reporting.
--
-- REJECTED FIX (verified broken this session): restoring the `SET statement_timeout = '300s'; CALL ...`
-- in-command prefix (the pattern migration 20260810040308 uses for the SELECT-based jobs) FAILS for a
-- PROCEDURE: pg_cron wraps a multi-statement command in one transaction, and the procedure's internal
-- COMMIT then raises `2D000 invalid transaction termination` (reproduced live: the 01:33Z test run died
-- at line 30). That is exactly why the prefix migration only ever touched `SELECT public.<fn>()` jobs
-- and why the prefix was dropped when 259 became a resumable procedure.
--
-- FIX (this migration): keep the single-statement CALL (required for the internal COMMIT) and shrink
-- the soft deadline to 10s. Because the procedure orders wallets STALEST-FIRST, the cold/large wallets
-- are picked first at t~1s, giving the one in-flight wallet the near-full ~119s budget (observed worst
-- 105s < 120s). A small cumulative deadline prevents the late-entry straddle that caused the 08-14
-- abort. Moved off the 13:33Z daily slot to hourly at :44 (dodges the :13 / 6-hourly / daily heavy
-- clusters) so the backlog drains ~1 cold wallet per run and steady-state runs are near-empty. A
-- truncated partial sweep now returns cleanly (cron status 'succeeded'; pipeline_runs ok=false is the
-- honest "did not finish" signal). Verified live: the 2026-08-16 01:37Z run SUCCEEDED (30.7s, clean).
--
-- Applied at runtime via cron.alter_job (this file is the idempotent record for repo<->prod parity).
--
-- REVERT (restores the pre-repair state):
--   SELECT cron.alter_job(259, schedule => '33 13 * * *',
--     command => 'CALL public.reconcile_all_saved_wallet_stats();');
--
-- KNOWN RESIDUAL (not a bug, do NOT "fix" by re-stamping): ~21 saved_wallets are empty-collection rows
-- (cached_moment_count=0, 0 wallet_moments_cache rows). The procedure deliberately never re-stamps them
-- (nothing to compute), so cache_updated_at stays pinned and any drift query that counts stale rows
-- WITHOUT excluding empties will always report ~21 "stale" even when the job is perfectly healthy.
-- The meaningful health check is stale wallets that HAVE wmc rows.

SELECT cron.alter_job(
  job_id  := 259,
  schedule := '44 * * * *',
  command  := 'CALL public.reconcile_all_saved_wallet_stats(10, 40, 360);'
);
