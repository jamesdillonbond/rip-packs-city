-- Found from the cron console sweep + cron.job_run_details on Sunday 03:43Z (Saturday 8:43 PM PT,
-- 2026-09-19): jobid 478 `rpc-weekly-wmc-reindex-6` (cron_heavy, `43 3 * * 0`) failed with
-- `relation "public.idx_wmc_wallet_coll_ek_fmv" does not exist`. That index was DROPPED on
-- 2026-09-14 (`20260914001500`, superseded by `idx_wmc_wallet_coll_ek_fmv_tier`, 403 MB — the
-- covering index wmc's FMV path reads), and the weekly REINDEX job that maintained it was never
-- re-pointed: its 09-12 run succeeded (before the drop), tonight's was its first tick since and
-- it died instantly. A weekly job aimed at a dropped object is pure silence in `pipeline_runs`
-- and a red row in `cron.job_run_details` once a week.
--
-- Re-pointed in place at the successor (same jobname + same owner ⇒ jobid preserved, asserted).
-- The campaign's sizing holds: sibling jobid 477 reindexes the 399 MB
-- `idx_wmc_lock_wallet_coll_cover` in ~59 s on a normal Sunday (09-12).
--
-- ⚠ Same tick, same night, different cause: jobid 477 DIED at its 600 s cron_heavy budget at
-- 8:23–8:33 PM PT and left `idx_wmc_lock_wallet_coll_cover_ccnew` (79 MB, indisvalid = false).
-- That was collateral of this session's concurrent pack_rips autovacuum pass (ledger, same
-- date); the leftover is dropped by a one-off `DROP INDEX CONCURRENTLY IF EXISTS` (jobid 561,
-- unscheduled in-session) exactly as `run_wmc_reindex_verify()`'s note prescribes. The 04:03Z
-- verify tick is expected to read `invalid_left = 0` after that drop.
--
-- Applied from Cowork cloud 2026-09-19 8:56 PM PT. ⚠ That session's push tooling is its own
-- concern; this file commits as usual.
--
-- EXIT: next Sunday 8:43 PM PT (03:43Z) jobid 478 `succeeded` with message REINDEX, and
-- `run_wmc_reindex_verify()` reads invalid_left = 0.
-- FALSIFIER: 478 dies at 600 s on a quiet Sunday ⇒ the 403 MB tier index outgrew the weekly
-- budget; drop the job rather than leave a weekly `_ccnew` generator.
-- REVERT: SET LOCAL ROLE cron_heavy; SELECT cron.unschedule('rpc-weekly-wmc-reindex-6'); RESET ROLE;

SET LOCAL ROLE cron_heavy;
SELECT cron.schedule(
  'rpc-weekly-wmc-reindex-6',
  '43 3 * * 0',
  'REINDEX INDEX CONCURRENTLY public.idx_wmc_wallet_coll_ek_fmv_tier'
);
RESET ROLE;

DO $$
DECLARE v_id int; v_cmd text; v_user text;
BEGIN
  SELECT jobid, command, username INTO v_id, v_cmd, v_user FROM cron.job WHERE jobname = 'rpc-weekly-wmc-reindex-6';
  IF v_id IS DISTINCT FROM 478 THEN RAISE EXCEPTION 'jobid changed: %', v_id; END IF;
  IF v_user <> 'cron_heavy' THEN RAISE EXCEPTION 'owner changed: %', v_user; END IF;
  IF strpos(v_cmd, 'idx_wmc_wallet_coll_ek_fmv_tier') = 0 THEN RAISE EXCEPTION 'command not applied: %', v_cmd; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_wmc_wallet_coll_ek_fmv_tier') THEN RAISE EXCEPTION 'target index missing'; END IF;
END $$;
