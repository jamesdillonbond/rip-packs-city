-- audit_20260903_wmc_reindex_becomes_weekly_maintenance_with_its_verify
--
-- Closes the CADENCE DECISION known-issues #56 asked for: the four wallet_moments_cache
-- indexes the 08-30/31 campaign rebuilt are now REINDEXed CONCURRENTLY every Sunday in the
-- measured quiet band, followed by the existing run_wmc_reindex_verify() so the
-- `wmc-reindex-verify` instrument gets a reading it can pass, once a week, instead of
-- being permanently red on three ad-hoc runs.
--
-- THE RATE, re-measured 2026-09-03 22:29Z (pg_relation_size), which is what turns
-- "should this be scheduled?" into a number:
--     idx_wmc_cohort_cover               165.7 MB (08-31 03:43Z) -> 299.2 (09-01 20:23Z) -> 326.4 (09-02 13:35Z) -> 359 (09-03 22:29Z)
--     idx_wmc_coll_ek_serial_cover       168.5 -> 289.0 -> 311.5 -> 336
--     idx_wmc_moment_collection_cover    149.1 -> 250.1 -> 263.4 -> 274
--   Regrowth is DECELERATING (cohort_cover +64 MB/day, then +38, then +24) as freed pages are
--   reused, i.e. it is converging back toward the 22-28 % density the campaign started from,
--   not growing without bound. Four days out, density is already under the verify's 60 %
--   floor (299 MB read 45.13 % on 09-01; 359 MB is ~37 % on the same live-entry count). The
--   whole table's index footprint is 2,159 MB against a 939 MB heap (19 indexes).
--   ⚠ #56's hypothesis that regrowth ACCELERATED after 08-30 is not supported by these three
--   intervals; it is the ordinary fill-then-slow curve.
--
-- WHY WEEKLY, and why inside the STANDING 600 s budget rather than the 1800 s window the
-- second wave needed:
--   * The 08-31 second wave measured the actual cost in the quiet band: 34 s, 50 s, 33 s, 33 s
--     per index at 02:03-03:43Z (cron.job_run_details). The 08-30 first wave died at 600 s
--     because it ran at 08:09Z, in the saturated band, where a REINDEX CONCURRENTLY sits in
--     wait phases behind the wmc upsert stream. Same 02Z-03Z slots, same minute pattern
--     (:03/:23/:43 were the free minutes then and still are), Sunday only.
--   * 12x headroom under 600 s on Sunday's quietest hour is enough that the ALTER ROLE
--     dance (widen cron_heavy to 1800 s, then restore) is not worth its own failure mode —
--     the 08-31 04:03Z restore job itself read `job canceled`.
--   * A slot that DOES exceed 600 s fails and leaves `<index>_ccnew` INVALID: harmless to
--     readers, still maintained on writes, and REPORTED by the verify slot
--     (`invalid_left`, ok=false) — the 08-30 design. It is not auto-dropped here because
--     DROP INDEX CONCURRENTLY cannot run inside a function or a multi-statement job
--     either; if the verify ever reports one, drop it by hand:
--     `DROP INDEX CONCURRENTLY IF EXISTS public.<index>_ccnew;` as ONE bare statement.
--   * ⚠ A pg_cron `failed` on a REINDEX job is NOT "work not done" — REINDEX CONCURRENTLY
--     commits its phases outside a transaction block (ledger 2026-08-30, 448 MB freed under
--     a "total failure" log). Read the verify row, not job_run_details.
--
-- ORDER within the hour is the same as the second wave (smallest live set last so the
-- verify's pgstatindex reads, ~1.2 GB across four indexes, land after the builds):
--     02:03Z  idx_wmc_coll_ek_serial_cover
--     02:23Z  idx_wmc_moment_collection_cover
--     02:43Z  wallet_moments_cache_wallet_collection_moment_key
--     03:03Z  idx_wmc_cohort_cover
--     03:23Z  run_wmc_reindex_verify()   -> pipeline_runs 'wmc-reindex-verify'
--
-- Owner cron_heavy (MAINTAIN on wallet_moments_cache verified still granted 2026-09-03;
-- PG 17 MAINTAIN covers REINDEX). `SET LOCAL ROLE cron_heavy` so the jobs are owned by the
-- role that carries the 600 s statement_timeout; `RESET ROLE` so apply_migration can write
-- schema_migrations. Each REINDEX job is exactly ONE statement — a `SET` in front of it
-- makes an implicit transaction block and CONCURRENTLY refuses to run.
--
-- REVERT (all five, by name):
--   SET LOCAL ROLE cron_heavy;
--   SELECT cron.unschedule('rpc-weekly-wmc-reindex-1'); SELECT cron.unschedule('rpc-weekly-wmc-reindex-2');
--   SELECT cron.unschedule('rpc-weekly-wmc-reindex-3'); SELECT cron.unschedule('rpc-weekly-wmc-reindex-4');
--   SELECT cron.unschedule('rpc-weekly-wmc-reindex-verify');
--   RESET ROLE;

SET LOCAL ROLE cron_heavy;

SELECT cron.schedule('rpc-weekly-wmc-reindex-1', '3 2 * * 0',
  'REINDEX INDEX CONCURRENTLY public.idx_wmc_coll_ek_serial_cover');
SELECT cron.schedule('rpc-weekly-wmc-reindex-2', '23 2 * * 0',
  'REINDEX INDEX CONCURRENTLY public.idx_wmc_moment_collection_cover');
SELECT cron.schedule('rpc-weekly-wmc-reindex-3', '43 2 * * 0',
  'REINDEX INDEX CONCURRENTLY public.wallet_moments_cache_wallet_collection_moment_key');
SELECT cron.schedule('rpc-weekly-wmc-reindex-4', '3 3 * * 0',
  'REINDEX INDEX CONCURRENTLY public.idx_wmc_cohort_cover');
SELECT cron.schedule('rpc-weekly-wmc-reindex-verify', '23 3 * * 0',
  'SELECT public.run_wmc_reindex_verify();');

RESET ROLE;
