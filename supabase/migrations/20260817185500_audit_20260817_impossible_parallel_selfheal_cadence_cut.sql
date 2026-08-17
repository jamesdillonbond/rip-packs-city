-- audit_20260817_impossible_parallel_selfheal_cadence_cut
--
-- Cut pg_cron jobid 219 `rpc-selfheal-impossible-parallel-circ` from hourly
-- (`52 * * * *`) to 6-hourly (`52 */6 * * *`). Schedule ONLY — the function
-- `public.raise_impossible_parallel_circ()` is not touched.
--
-- WHY. The job is NOT waste (a `sum(rows_written)=0` sweep would have retired it
-- and destroyed live data-integrity healing): it raises `editions.circulation_count`
-- to `max(serial_number)` for Top Shot parallels where a sale's serial exceeds the
-- recorded circulation, which feeds serial multipliers, the special-serial boards
-- and the `topshot_impossible_parallel_serials` trust arm. It is simply polled ~28x
-- more often than its work arrives.
--
-- MEASURED 2026-08-17 (re-derived, not taken from the filing):
--   * output          147 raises all-time, 20 in the trailing 7 days, newest 08-16 20:52Z
--   * productivity    6 distinct productive hours out of 168 runs in 7 days
--   * cost            pg_stat_statements over a 5.74-day window: 134 calls,
--                     mean 47,085 ms, 21,215,994 blocks read = 161.9 GB (~28.2 GB/day),
--                     buffer hit ratio 6.4%
--   * headroom        `topshot_impossible_parallel_serials` currently reads 0 (green)
-- At `*/6` the job runs 28x/week instead of 168x/week — roughly a 6x cut, ~23 GB/day
-- of disk reads returned to an IO-throttled instance whose saturation is the
-- documented common cause behind the fmv-recalc kills, the insights board-warm
-- failures, the entity-page pool timeouts and the pgcron startup timeouts.
--
-- SAFETY — all four grounds re-verified live rather than trusted:
--   1. MONOTONIC + IDEMPOTENT. The UPDATE carries `o.new_circ > e.circulation_count`
--      (commented "MONOTONIC: raise only"), so offenders accumulate and a later run
--      heals anything an earlier run missed. Re-running changes nothing.
--   2. NOTHING KEYS ON ITS FRESHNESS. Measured: 0 `pipeline_cadence_watchlist` arms,
--      0 views reading the function or `impossible_parallel_circ_raises`, 0 other
--      functions referencing either. (This is the step whose omission produced the
--      live `board_mv_refresh_stale_hours` breach — a threshold nobody re-derived
--      after changing the cadence it measures.)
--   3. ITS ONLY CONSUMER IS ALREADY 6-HOURLY. jobid 324 `rpc-thp-leg-impossible-parallel`
--      runs `48 0,6,12,18`, so an hourly producer bought the board nothing.
--   4. SOLE DRIVER. Exactly 1 cron caller (this job); no GHA, no in-repo fetch.
--
-- ACCEPTED COST, stated rather than glossed: an offender now waits up to ~6 h to be
-- healed instead of up to ~1 h, on ~3 editions/day. The direction is conservative —
-- while `serial > circulation_count`, `serialMultiplier`'s tail term
-- `1 + 0.08*max(0, 1 - serial/circ)` clamps to 1.0, so an unhealed edition is priced
-- with a SMALLER premium, not an inflated one.
--
-- ⚠ `SET LOCAL ROLE cron_heavy` is load-bearing: `cron.schedule` on an existing job
-- name updates in place and sets the owner to the CURRENT role, so without it the job
-- is re-owned and silently loses cron_heavy's 600 s statement_timeout. `cron.alter_job`
-- is denied to cron_heavy, so `cron.schedule` is the path.
-- ⚠ `RESET ROLE` is equally load-bearing: apply_migration appends its own INSERT into
-- `supabase_migrations.schema_migrations`, which cron_heavy cannot write — leaving the
-- role set fails the whole migration.
-- ⚠ The function declares `SET statement_timeout TO '120s'`, which is INERT (the
-- documented proconfig rule). Do not reach for it; the binding budget is cron_heavy's.
--
-- REVERT (restores hourly):
--   SET LOCAL ROLE cron_heavy;
--   SELECT cron.schedule('rpc-selfheal-impossible-parallel-circ', '52 * * * *',
--                        'SELECT public.raise_impossible_parallel_circ();');
--   RESET ROLE;

SET LOCAL ROLE cron_heavy;

SELECT cron.schedule(
  'rpc-selfheal-impossible-parallel-circ',
  '52 */6 * * *',
  'SELECT public.raise_impossible_parallel_circ();'
);

RESET ROLE;
