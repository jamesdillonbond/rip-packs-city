-- audit_20260903_impossible_parallel_selfheal_runs_before_its_own_trust_leg
--
-- Move pg_cron jobid 219 `rpc-selfheal-impossible-parallel-circ` from `52 */6 * * *`
-- to `43 0,6,12,18 * * *`. Schedule ONLY — same four hours a day, same function,
-- `public.raise_impossible_parallel_circ()` untouched.
--
-- WHY. The trust arm `topshot_impossible_parallel_serials` is read by leg jobid 324
-- (`48 0,6,12,18`) and its offenders are HEALED by jobid 219 four minutes LATER
-- (`52 */6` = the same four hours). Both use the identical predicate
-- (Top Shot `::` parallel editions, `circulation_count > 0`, `sales.serial_number >
-- circulation_count`), so every inflow that lands in a six-hour window is counted at
-- :48, raised away at :52, and then reported as a BREACH for the next six hours on a
-- condition that no longer exists. Measured 2026-09-03: the leg wrote 8 at 18:48Z;
-- the healer raised five editions (eight sales) at 18:52Z; a live re-run of the leg's
-- own SQL at 22:00Z read 1 (a fresh 21:29Z sale on 252:8919::21 — a genuine Galactic
-- parallel per topshot_moment_subeditions, serial 5 against a declared circulation of
-- 4, i.e. the same stale-circulation class the healer exists for). The daytime monitor
-- filed that 8 as a NEW HIGH regression (inbox 2026-09-03T2110Z); it was the healer's
-- routine inflow, already gone.
--
-- The 2026-08-17 cadence cut recorded "its only consumer is already 6-hourly" as a
-- safety ground and missed that the consumer reads BEFORE the producer runs. This
-- migration fixes the order: heal at :43, read at :48. The healer takes 10–12 s on
-- every run since 08-31 and 38–152 s in the week before (cron.job_run_details), so it
-- finishes inside the five-minute gap on either regime; minute 43 in hours 0/6/12/18
-- holds no other job (jobid 332 rpc-refresh-special-serial-owners-mv is `43 4,16`).
--
-- WHAT THE ARM MEANS AFTERWARDS, stated so nobody re-diagnoses it: it counts what the
-- healer could NOT raise away — a run that timed out, a `circulation_count` of 0 the
-- healer's predicate skips, or a writer that mis-keys faster than four heals a day. The
-- INFLOW itself is not lost: every raise is a row in impossible_parallel_circ_raises
-- (9 on 2026-09-03, 8 on 08-31, 11–17/day mid-August), which is the table to read for
-- "how often does a parallel's declared circulation turn out stale". ⚠ A persisting
-- nonzero reading is now a real signal, not a six-hour echo.
--
-- ⚠ `SET LOCAL ROLE cron_heavy` is load-bearing: `cron.schedule` on an existing job
-- name updates in place and sets the owner to the CURRENT role, so without it the job
-- is re-owned and silently loses cron_heavy's 600 s statement_timeout. `cron.alter_job`
-- is denied to cron_heavy, so `cron.schedule` is the path (proven 2026-08-16, 08-17).
-- ⚠ `RESET ROLE` is equally load-bearing: apply_migration appends its own INSERT into
-- `supabase_migrations.schema_migrations`, which cron_heavy cannot write.
--
-- REVERT (restores the read-then-heal order):
--   SET LOCAL ROLE cron_heavy;
--   SELECT cron.schedule('rpc-selfheal-impossible-parallel-circ', '52 */6 * * *',
--                        'SELECT public.raise_impossible_parallel_circ();');
--   RESET ROLE;

SET LOCAL ROLE cron_heavy;

SELECT cron.schedule(
  'rpc-selfheal-impossible-parallel-circ',
  '43 0,6,12,18 * * *',
  'SELECT public.raise_impossible_parallel_circ();'
);

RESET ROLE;
