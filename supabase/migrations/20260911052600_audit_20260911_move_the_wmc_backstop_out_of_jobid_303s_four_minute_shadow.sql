-- ============================================================================
-- MOVE THE wmc BACKSTOP OUT OF jobid 303'S SHADOW — 2026-09-10 PT (same night)
--
-- 🚨 A CORRECTION TO THE MIGRATION SHIPPED MINUTES AGO, CAUGHT BY READING THE
-- ROUTE'S OWN INCIDENT RECORD RATHER THAN THE CRON TABLE. I picked
-- `3,18,33,48` because those minutes collide with neither jobid 302 (minutes
-- = 2 mod 5) nor jobid 303 (7 mod 10) — which is true of the FIRING INSTANTS
-- and irrelevant, because what matters is how long the other job RUNS.
--
-- `app/api/wmc-fmv-populate/route.ts` records it exactly: "pg_cron jobid 303
-- (`7-57/10`) runs a median of 240s, so the route's tick one minute later used
-- to block ~18s on wallet_moments_cache row locks and die. 83 of 84 lock
-- timeouts in 48h landed on :08/:18/:28/:38/:48/:58, one minute after each 303
-- firing." ⛔ **`:18` and `:48` are two of those exact minutes.** I had put the
-- backstop inside the documented collision window.
--
-- ⚠ THE GENERAL TRAP: a cron-collision check on MINUTES is a check on start
-- times, and a job with a 4-minute median occupies 4 minutes of them. 303 is
-- busy 7–11, 17–21, 27–31, 37–41, 47–51, 57–01. New minutes **4, 24, 44** sit
-- in its free gaps (1–7, 21–27, 41–47) and are ≡ 4 mod 5, so they still miss
-- 302. Three ticks an hour instead of four: with the 15-minute staleness
-- threshold that is at most ~35 minutes of silence before takeover, against a
-- watchlist `max_silent_minutes` of 120 for this lane.
--
-- ⚠ Note what this does NOT rely on: `refresh_wmc_fmv_changed` returns NULL
-- when another instance holds its advisory lock, but this backstop calls
-- `refresh_wmc_fmv_drift_active`, which has no such skip — so avoiding the
-- window is the protection, not a retry.
--
-- REVERT: re-schedule with '3,18,33,48'. The function is unchanged.
-- ============================================================================

SELECT cron.schedule(
  'rpc-wmc-fmv-populate-backstop',
  '4,24,44 * * * *',
  $cron$SET statement_timeout = '180s'; SELECT public.rpc_wmc_fmv_populate_backstop();$cron$
);
