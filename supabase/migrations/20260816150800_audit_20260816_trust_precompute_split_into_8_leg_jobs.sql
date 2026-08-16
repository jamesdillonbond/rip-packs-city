-- audit_20260816 (2026-08-16 15:08Z / 08:08 PT): split rpc_trust_health_precompute_refresh_p
-- (pg_cron jobid 287) into EIGHT independent pg_cron jobs, one per leg.
--
-- SYMPTOM: the trust board was publishing STALE VALUES AS CURRENT, progressively worse.
-- Measured 2026-08-16 14:55Z, 19 precompute rows:
--     3 rows  @ 12:58Z (2.1h)  legs 1-2   panini, pinnacle_fmv_share
--    15 rows  @ 06:58Z (8.0h)  legs 3-7   pack_ev, fmv_sanity, serial_supply, fmv_coverage, board_liveness
--     1 row   @ 00:59Z (14.1h) leg 8      impossible_parallel
-- Five of the last six ticks failed at the 600s budget. v_rpc_trust_health exposes NO per-metric
-- age, so a frozen leg is indistinguishable from a current one; the only thing standing between that
-- and an operator acting on a stale number is the trust_precompute_max_age_hours arm (breached).
--
-- ROOT CAUSE (arithmetic, not a pathological query): the procedure was eight
-- "PERFORM public.rpc_thp_leg_*(); COMMIT;" lines sharing ONE cron_heavy 600s statement_timeout.
-- The legs OWN declared budgets sum to 1,650s:
--     panini 60 + pinnacle_fmv_share 90 + pack_ev 120 + fmv_sanity 180 + serial_supply 180
--     + fmv_coverage 240 + board_liveness 300 + impossible_parallel 480 = 1650s
-- ...inside a 600s budget. It could never fit. (Those per-function proconfig timeouts are also
-- INERT -- a function-level SET does not bind statements inside it on this instance -- so the real
-- and only budget was the cron_heavy role 600s, shared by the whole CALL.)
-- Because each leg COMMITs before the next runs, a kill at 600s leaves the legs it reached fresh
-- and everything behind it frozen: a PARTIAL refresh, not an outage. Leg 8 is stalest by POSITION
-- (it is last), NOT because its query is slowest -- do not go optimize that query.
--
-- ⚠ THE LOAD-BEARING PROOF -- a COMMIT does NOT re-arm the statement timer. The per-leg-COMMIT
-- design (jobid 222 function -> jobid 287 PROCEDURE _p) was built on the belief that it did.
-- Three consecutive ticks refute it:
--     08-16 00:58   8 of 8 legs   491.0s   ok
--     08-16 06:58   7 of 8 legs   600.0s   timeout
--     08-16 12:58   2 of 8 legs   600.0s   timeout
-- If the timer re-armed, the 06:58 run (7 legs over ~532s, then leg 8) would have reached ~1130s.
-- BOTH failures cap at exactly 600.0s regardless of how many legs finished -- the signature of one
-- governor, not a workload. The whole CALL is ONE statement under cron_heavy's single 600s budget;
-- per-leg COMMIT buys DURABILITY of finished legs, not a fresh budget. That is precisely why the
-- remedy has to be one cron job per leg, and why no amount of reordering or rescheduling helps.
--
-- WHY NOT the alternatives (each measured/considered, do not re-derive):
--  * Raise the 600s timeout -- rejected. Same disk-IO budget as fmv-recalc and the board warms; a
--    longer run holds a pooled connection longer on the instance that is already saturating.
--  * Reschedule 287 to a "good" hour -- rejected, and this is the load-bearing one. The 06:58Z slot
--    had a 6-for-6 success record when that fix was filed 2026-08-15 21:10Z and FAILED the next day.
--    Rescheduling only chooses which legs starve. The surviving 00:58Z slot runtime went
--    63 -> 275 -> 501 -> 491s over four days (82% of budget) and was days from failing too.
--  * Add EXCEPTION handlers to reach the 999 sentinel -- already rejected 2026-08-15 (255e7d24,
--    shipped and reverted same session): PostgreSQL excludes QUERY_CANCELED from WHEN OTHERS, and
--    after a cancel is caught the timer is NOT re-armed, so every remaining leg runs UNBOUNDED.
--
-- FIX: nothing transactional binds the legs (verified: 8 COMMITs in prosrc), so each becomes its own
-- TOP-LEVEL cron statement and therefore gets its own fresh 600s cron_heavy budget. A slow leg now
-- delays only itself instead of starving every leg behind it. Legs are spread across HOUR OFFSETS so
-- only one leg runs per hour, while each still refreshes every 6h (unchanged freshness contract;
-- expected max age ~6h + runtime, well under the arm breach_at of 13).
--
--   jobid 324  rpc-thp-leg-impossible-parallel   48 0,6,12,18   (heaviest, 480s decl, #3 disk reader)
--   jobid 325  rpc-thp-leg-fmv-coverage          48 1,7,13,19   (writes 10 of the 19 metrics)
--   jobid 326  rpc-thp-leg-board-liveness        48 2,8,14,20
--   jobid 327  rpc-thp-leg-serial-supply         48 3,9,15,21
--   jobid 328  rpc-thp-leg-fmv-sanity            48 4,10,16,22
--   jobid 329  rpc-thp-leg-pack-ev               48 5,11,17,23
--   jobid 330  rpc-thp-leg-panini                 9 0,6,12,18   (cheapest, paired off the :48 lane)
--   jobid 331  rpc-thp-leg-pinnacle-fmv-share     9 3,9,15,21
--
-- Minutes 9 and 48 were verified EMPTY across all hours before use (minute 8 was rejected -- jobid
-- 220 rpc-allday-dedup-full-weekly sits at 08:08).
--
-- MECHANISM NOTE: 287 and the new legs are owned by cron_heavy, and cron.alter_job is a pincer --
-- postgres does not own them, and cron_heavy has no EXECUTE on alter_job. The working path
-- (verified live: postgres IS a member of cron_heavy; cron_heavy CAN execute cron.schedule) is
--     SET LOCAL ROLE cron_heavy;  SELECT cron.schedule(...);
-- The SET LOCAL ROLE is LOAD-BEARING: run as postgres, cron.schedule re-owns the job to postgres and
-- it silently loses the cron_heavy rolconfig statement_timeout=600s. Applied via a rolled-back
-- DO-block probe first (readback confirmed 8 jobs, owner=cron_heavy, active), then for real.
--
-- Applied at runtime via cron.schedule/cron.unschedule (this file is the idempotent record for
-- repo<->prod parity; it contains no DDL, so it causes no PGRST002 schema-cache burst).
--
-- VERIFY (next ticks; do NOT judge from a single tick):
--   select metric, computed_at, round(extract(epoch from (now()-computed_at))/3600,2) age_h
--     from public.rpc_trust_health_precompute order by computed_at;
--   -- expect ALL 19 rows to converge under ~7h, and trust_precompute_max_age_hours < 13.
--   select jobid, status, start_time, end_time-start_time as dur from cron.job_run_details
--    where jobid between 324 and 331 order by start_time desc;
--
-- KNOWN RESIDUAL (do NOT "fix" by thresholding): trust_precompute_max_age_hours reads max(age) over
-- ALL rows, so one perpetually-failing leg still pins it red. Now that legs are split, the arm SHOULD
-- be re-pointed to report per-leg -- filed, not taken here (that is a view change, not a schedule one).
--
-- REVERT (restores the single monolithic job exactly):
--   do $$
--   begin
--     set local role cron_heavy;
--     perform cron.unschedule('rpc-thp-leg-impossible-parallel');
--     perform cron.unschedule('rpc-thp-leg-fmv-coverage');
--     perform cron.unschedule('rpc-thp-leg-board-liveness');
--     perform cron.unschedule('rpc-thp-leg-serial-supply');
--     perform cron.unschedule('rpc-thp-leg-fmv-sanity');
--     perform cron.unschedule('rpc-thp-leg-pack-ev');
--     perform cron.unschedule('rpc-thp-leg-panini');
--     perform cron.unschedule('rpc-thp-leg-pinnacle-fmv-share');
--     perform cron.schedule('rpc-trust-health-precompute-refresh','58 */6 * * *',
--                           'CALL public.rpc_trust_health_precompute_refresh_p()');
--   end $$;

do $$
begin
  set local role cron_heavy;
  perform cron.schedule('rpc-thp-leg-impossible-parallel','48 0,6,12,18 * * *','SELECT public.rpc_thp_leg_impossible_parallel();');
  perform cron.schedule('rpc-thp-leg-fmv-coverage',       '48 1,7,13,19 * * *','SELECT public.rpc_thp_leg_fmv_coverage();');
  perform cron.schedule('rpc-thp-leg-board-liveness',     '48 2,8,14,20 * * *','SELECT public.rpc_thp_leg_board_liveness();');
  perform cron.schedule('rpc-thp-leg-serial-supply',      '48 3,9,15,21 * * *','SELECT public.rpc_thp_leg_serial_supply();');
  perform cron.schedule('rpc-thp-leg-fmv-sanity',         '48 4,10,16,22 * * *','SELECT public.rpc_thp_leg_fmv_sanity();');
  perform cron.schedule('rpc-thp-leg-pack-ev',            '48 5,11,17,23 * * *','SELECT public.rpc_thp_leg_pack_ev();');
  perform cron.schedule('rpc-thp-leg-panini',             '9 0,6,12,18 * * *','SELECT public.rpc_thp_leg_panini();');
  perform cron.schedule('rpc-thp-leg-pinnacle-fmv-share', '9 3,9,15,21 * * *','SELECT public.rpc_thp_leg_pinnacle_fmv_share();');
  perform cron.unschedule('rpc-trust-health-precompute-refresh');
end $$;
