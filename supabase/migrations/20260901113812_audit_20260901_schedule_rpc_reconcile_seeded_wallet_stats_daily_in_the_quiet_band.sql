-- audit_20260901_schedule_rpc_reconcile_seeded_wallet_stats
--
-- Schedules public.reconcile_all_seeded_wallet_stats (migrations 20260901110757 +
-- 20260901112618) as a daily pg_cron job.
--
-- VERIFIED BEFORE SCHEDULING, not after. A throwaway job
-- `tmp-verify-reconcile-seeded-wallet-stats` (jobid 431, since unscheduled) ran the
-- exact command below at 11:32:00.18Z -> 11:34:12.44Z:
--   status succeeded, return_message CALL
--   pipeline_runs row: ok=true, rows_found 52, rows_written 4, rows_skipped 48,
--     extra = {wallets_ok:4, wallets_failed:0, wallets_done:4, truncated:true,
--              elapsed_ms:132243, oldest_active_h:26.6}
--
-- The two structurally-unrefreshable wallets, before -> after:
--   0x0d744d23165bfb6c  601.3 h stale -> 0    count 154,237 -> 155,411 (+1,174)
--                                            FMV $110,716.93 -> $108,421.26 (-2.07%)
--   0xee4fe6c87ab048d0  489.6 h stale -> 0    count  67,381 ->  67,445 (+64)
--                                            FMV  $91,513.97 -> $113,608.68 (+24.1%)
-- The #2 active seeded wallet had been displaying an FMV 24% below its real value
-- for 20 days. `oldest_active_h` for the whole ACTIVE population: 601.3 -> 26.6.
--
-- ⚠ HONEST CAVEAT ON THE 132 s: that run had a partly-warm cache from this pass's
-- own probes. The cold single-whale reading, from the failed 11:18 attempt, was
-- 111 s for ONE wallet. A genuinely cold daily tick will be slower than 132 s. The
-- 300 s p_max_seconds budget has headroom but not a large one -- if
-- `truncated: true` starts appearing with wallets_done < 2, raise p_max_seconds
-- before raising p_max_wallets.
--
-- SLOT: 09:28Z = 02:28 PT, inside the quiet band (the saturation band is
-- 19:30-01:00Z). Minute 28 is used by only one other job (288, hours 0,6,11,20);
-- hour 9 holds 201 (:10), 11 (:45), 249 (:56), plus hourly 408 (:09) and 26 (:17).
--
-- ⛔ The SET prefix is LOAD-BEARING and so is the absence of COMMIT in the callee:
--   * postgresql.conf statement_timeout = 120 s and role postgres has no override,
--     so a bare CALL would be clipped below the ~111 s cold whale.
--   * A SET-prefixed pg_cron command is an IMPLICIT TRANSACTION BLOCK, so the
--     callee must not COMMIT (see 20260901112618).
--   Changing either one alone breaks the job. Change both or neither.
--
-- REVERT: SELECT cron.unschedule('rpc-reconcile-seeded-wallet-stats');
-- ⓘ NOT added to pipeline_cadence_watchlist deliberately: a brand-new arm on a job
--   with no run history is how this repo ends up muting its own alerts. Add the arm
--   once ~7 ticks of `reconcile-seeded-wallet-stats` pipeline_runs rows exist and a
--   real cadence + max_silent_minutes can be derived from them rather than guessed.

DO $mig$
DECLARE
  v_jobid bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'reconcile_all_seeded_wallet_stats'
      AND p.prokind = 'p'
  ) THEN
    RAISE EXCEPTION 'pre-flight failed: public.reconcile_all_seeded_wallet_stats procedure not found';
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-reconcile-seeded-wallet-stats') THEN
    RAISE EXCEPTION 'pre-flight failed: jobname rpc-reconcile-seeded-wallet-stats already exists';
  END IF;

  SELECT cron.schedule(
    'rpc-reconcile-seeded-wallet-stats',
    '28 9 * * *',
    $cmd$SET statement_timeout = '900s'; CALL public.reconcile_all_seeded_wallet_stats(300, 4, 1200);$cmd$
  ) INTO v_jobid;

  RAISE NOTICE 'scheduled rpc-reconcile-seeded-wallet-stats as jobid %', v_jobid;
END
$mig$;