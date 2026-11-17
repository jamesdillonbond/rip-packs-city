-- audit_20260920: cadence watchlist row for `refresh-conflated-editions` — the lane that
-- writes BOTH Top Shot deal-board honesty guards and was covered by NOTHING.
--
-- ── MEASURED 2026-09-20, ~11:25 AM PT ──────────────────────────────────────────
-- `public.topshot_thin_fmv_editions` (the deal board's "thin data" caveat set, which
-- alerts also suppress on) held 7 rows, EVERY ONE stamped 2026-09-18 01:30 PT —
-- 57.9 hours stale. Both of its writers were down at the same time:
--   * /api/cron/refresh-conflated-editions, killed at its 120 s Vercel wall on
--     09-19 and 09-20 (a `-heartbeat` row each day, no terminal row);
--   * pg_cron job 63 `rpc-refresh-thin-fmv-guard` (30 8 * * *), FAILED both days
--     with `canceling statement due to statement timeout` at ~604 s.
--
-- ⚠ The function itself declares `SET statement_timeout TO '120s'` and pg_cron ran it
-- for 604 s anyway — the documented "SET statement_timeout on a function is INERT on
-- pg_cron" trap, confirmed live rather than quoted.
--
-- ── WHY IT WAS SILENT FOR 58 HOURS: FOUR INSTRUMENTS, ZERO COVERAGE ───────────
--   1. `v_pipeline_failure_rates` — `HAVING sum(runs) >= 5` over a 2-day window.
--      This lane is DAILY, so it can never reach the floor. It has never been able
--      to report this pipeline at all, in either direction.
--   2. `pipeline_cadence_watchlist` — NO ROW for this pipeline. That is what this
--      migration fixes.
--   3. The `check_*` invariants — not one of them names thin_fmv (checked over
--      `pg_get_functiondef` for every `check\_%` in public: zero hits).
--   4. The pg_cron backstop's own failure — visible ONLY in `cron.job_run_details`,
--      never in `pipeline_runs`, exactly as CLAUDE.md warns.
--
-- ── WHY THIS ROW CAN ACTUALLY FIRE ───────────────────────────────────────────
-- `detect_stalled_pipelines()` keys on the TERMINAL row, and a `maxDuration` kill
-- writes none — so the 09-19 and 09-20 kills are precisely what the silence arm
-- sees. The no-success arm is the second half: the same-day commit makes this
-- route's `p_ok` mean THE LANES WORKED rather than "the body reached its end", so
-- a tick that completes with a failed thin-FMV refresh now lands as ok=false and
-- ages into `max_minutes_without_success` instead of reporting `thin_fmv_flagged: 0`.
--
-- NUMBERS, from the cadence not from preference. Daily at 08:17 PT. 1800 min fires
-- on the FIRST missed tick (a daily lane that misses one is silent 2880 min) —
-- deliberate, and the same basis as `apply-fmv-haircut` and `candy-editions-ingest`,
-- whose notes spell out that arithmetic. 3600 = 2x, the seeded convention.
--
-- SEVERITY `medium` = visibility, does not page. Chosen over `high` on the estate's
-- own precedent (a lane is promoted only after a user-facing regression is traced to
-- it, per candy-offers-indexer 08-07 and candy-listings-indexer 08-15), and because
-- CLAUDE.md is explicit that the loudest signal should not be spent on a first
-- reading. ⭐ PROMOTE TO `high` if a stale thin-FMV set is ever traced to a confident
-- price shown on the deal board — that is the failure DIRECTION here: an edition that
-- became thin after the last successful refresh is NOT flagged, so the board shows a
-- confident discount and alerts do not suppress it. The opposite direction (a stale
-- flag left on an edition that is no longer thin) is merely over-cautious.
--
-- ── WHAT THIS ROW DOES *NOT* DO FOR THE NEXT 30 HOURS, stated rather than assumed
-- `detect_stalled_pipelines()` carries a deliberate new-row grace (added 2026-09-04):
--     AND w.created_at < now() - (w.max_silent_minutes * interval '1 minute')
-- so this row cannot fire until ~2026-09-21 17:30 PT. It is NOT armed on the very
-- stall that motivated it, and `created_at` is left TRUTHFUL rather than backdated —
-- the function reads that column as "how long has this arm been armed", and faking it
-- to win one tick would make the instrument lie about itself.
--
-- ⭐ POSITIVE CONTROL, run at apply time, so this is not shipped on the assumption
-- that it works. The arm's predicate with ONLY the grace clause removed selects the
-- lane today:
--     silent_minutes 4515  vs  max_silent_minutes 1800
--     last terminal row    2026-09-17 08:17:12 PT
--     last heartbeat       2026-09-20 08:17:10 PT
--     classification       'invoked_but_never_logged'   <- the function's own name
--                                                          for a route that ran and
--                                                          was killed before logging
--     grace_passed         false                        <- the only unmet condition
-- Every other condition is already true, so the threshold is right and the silence
-- is the grace.
--
-- ⚠ FILED, NOT FIXED HERE: that grace clause uses the ROW's age as a proxy for the
-- PIPELINE's age. The proxy holds for a genuinely new pipeline and is wrong in exactly
-- this case — an OLD lane getting a NEW row is graced as if it had never run. Changing
-- a function every watchlist row depends on, to win 30 hours on one lane, is the wrong
-- trade; it is recorded so the next reader does not mistake the silence for a bug.
--
-- REVERT: DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'refresh-conflated-editions';
INSERT INTO public.pipeline_cadence_watchlist (pipeline, severity, is_active, max_silent_minutes, max_minutes_without_success, notes)
VALUES (
  'refresh-conflated-editions', 'medium', true, 1800, 3600,
  'Daily 08:17 PT (cron-job.org -> /api/cron/refresh-conflated-editions). Writes BOTH Top Shot deal-board honesty guards: topshot_conflated_editions (parallel-conflation) and topshot_thin_fmv_editions (thin-data caveat). ARMED 2026-09-20 after measuring topshot_thin_fmv_editions 57.9 h stale with nothing watching: the route was killed at its 120 s wall on 09-19 and 09-20, AND pg_cron job 63 (rpc-refresh-thin-fmv-guard, the independent daily backstop) timed out at ~604 s on the same two days. Four instruments could have caught it and none covered this lane — v_pipeline_failure_rates needs 5 runs in 2 days and this is daily; there was no row here; no check_* names thin_fmv; and a pg_cron failure shows only in cron.job_run_details. 1800 min fires on the FIRST missed tick (a daily lane missing one is silent 2880), same basis as apply-fmv-haircut. Health is the TERMINAL row: a maxDuration kill writes none, which is exactly the 09-19/09-20 shape. ⚠ rows_written 0 is NOT a failure — the conflated set is slow-moving. PROMOTE medium->high only if a stale thin-FMV set is traced to a confident price on the deal board (the harmful direction: an edition that became thin is left unflagged). Revert: DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = ''refresh-conflated-editions''.'
)
ON CONFLICT (pipeline) DO UPDATE SET severity = EXCLUDED.severity, is_active = true,
  max_silent_minutes = EXCLUDED.max_silent_minutes,
  max_minutes_without_success = EXCLUDED.max_minutes_without_success,
  notes = EXCLUDED.notes;
