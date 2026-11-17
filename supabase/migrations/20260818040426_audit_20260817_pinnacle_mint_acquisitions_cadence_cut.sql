-- audit_20260817_pinnacle_mint_acquisitions_cadence_cut
--
-- Cut pg_cron jobid 218 `rpc-backfill-pinnacle-mint-acquisitions` from hourly
-- (`19 * * * *`) to 3-hourly (`19 */3 * * *`). Schedule ONLY — the function
-- `public.backfill_pinnacle_mint_acquisitions(int)` is not touched.
--
-- ORIGIN. Filed by rpc-daytime-monitor as
-- `docs/overnight/inbox/2026-08-18T0330Z-heavy-cron-collision-pinnacle-backfill-io.md`
-- during an active saturation spell. ⚠ The filing's HEADLINE CLAIM was REFUTED on
-- re-measurement and only its fix #1 survived. See that file's "RE-MEASURED" section.
-- This migration ships the surviving item and nothing else.
--
-- WHAT WAS REFUTED. The filing argued a `:13`–`:34` band of eight hourly heavy jobs
-- manufactures the spells, and that jobid 218 is "uncontended cheap (11–18 s)", a
-- victim that only balloons inside a spell. Both halves fail on measurement:
--
--   * The band is CONSTANT — the same jobs sit at the same minutes every hour — yet
--     218's concurrent-overlap over 48 h ranges 1 → 28. Overlap tracks 218's OWN
--     runtime almost linearly (11 s → 1 overlapping; 601 s → 28), never the minute.
--     The pileup is a CONSEQUENCE of long runtimes, not their cause. This is the same
--     result the 2026-08-16 jobid-71 measurement produced, where a filed `:13` stagger
--     was measured to make things strictly worse. Start-minute staggering stays dead.
--   * "Cheap uncontended" came from an 8-run tail. Over 7 days: 157 succeeded
--     avg 116.8 s / max 480.1 s, plus 11 failed avg 558.9 s / max 966.3 s — about
--     5.4 h/week of `cron_heavy`. It is not cheap.
--
-- THE ACTUAL MECHANISM (measured 2026-08-17 ~21:00 PT, quiet window, 3 IO-wait sessions):
-- the `LIMIT 50000` NEVER BINDS. `EXPLAIN` gives a Merge Anti Join streaming
-- ~247k `pinnacle_mint_events` against ~877k `moment_acquisitions` (rows=1 estimate),
-- then a nested-loop probe into `wallet_moments_cache` per survivor. Because only tens
-- of candidates exist, the LIMIT is never satisfied and EVERY run walks the join to
-- completion. So this is a FULL SWEEP wearing an incremental catch-up's clothes, and
-- its 11 s ↔ 966 s spread is just how much of the sweep is served from cache vs disk.
-- Corroboration that the cost is intrinsic, not contention: the same anti-join failed
-- to complete inside a 90 s budget in the quiet window.
--
-- OUTPUT, from the OUTCOME table rather than the self-report (`rows_written` is a null
-- instrument here): `moment_acquisitions WHERE source='pinnacle_mints'` gained 92 rows
-- on 08-17, 275 on 08-16, 102 on 08-15, 67 on 08-14 — i.e. tens per day across 24 runs,
-- against a 50,000-row per-run ceiling. Total 6,372 rows all-time.
--
-- WHY */3 IS SAFE. 8 runs/day × 50,000 ceiling ≫ a real arrival rate of ~10²/day, so
-- no row is dropped — only its recording is deferred. Nothing keys on the freshness of
-- an acquisition-history row (it is provenance, not pricing). Precedent: the sibling
-- `rpc-backfill-pinnacle-acquisitions` (jobid 78), the same class of work on the same
-- collection, already runs `17 */6` — hourly was the outlier, and */3 remains twice as
-- frequent as the sibling.
--
-- ACCEPTED COST, stated rather than glossed: a Pinnacle mint acquisition now waits up
-- to ~3 h to be recorded instead of up to ~1 h. Removes 16 of 24 daily full sweeps.
--
-- ⚠ NOT THE DURABLE FIX. The durable fix is to stop the full sweep — give the anti-join
-- a watermark or an index-supported "unprocessed" predicate so the LIMIT can bind. Until
-- that lands this job is 8 full sweeps/day rather than 24. Do not read this as closed.
--
-- ⚠ `SET LOCAL ROLE cron_heavy` is load-bearing: `cron.schedule` on an existing job name
-- updates in place and sets the owner to the CURRENT role, so without it the job is
-- re-owned and silently loses cron_heavy's 600 s statement_timeout. `cron.alter_job` is
-- denied to cron_heavy, so `cron.schedule` is the path.
-- ⚠ `RESET ROLE` is equally load-bearing: apply_migration appends its own INSERT into
-- `supabase_migrations.schema_migrations`, which cron_heavy cannot write — leaving the
-- role set fails the whole migration.
-- ⚠ Do NOT `cron.unschedule` first. That churns the jobid (109 → 332 happened on
-- 2026-08-16) and invalidates every filing, ledger entry and job_run_details query
-- keyed on it. Verified after this change: jobid is still 218, one row, owner cron_heavy.
-- ⛔ The filing's claim that pg_cron reschedule "cannot be done from the Supabase MCP
-- connection" is FALSE and is now the second time that dead end has been filed. The
-- pincer is real for `cron.alter_job` only; `cron.schedule` under `SET LOCAL ROLE` works.
--
-- REVERT (restores hourly):
--   SET LOCAL ROLE cron_heavy;
--   SELECT cron.schedule('rpc-backfill-pinnacle-mint-acquisitions', '19 * * * *',
--                        'SELECT public.backfill_pinnacle_mint_acquisitions(50000)');
--   RESET ROLE;

SET LOCAL ROLE cron_heavy;

SELECT cron.schedule(
  'rpc-backfill-pinnacle-mint-acquisitions',
  '19 */3 * * *',
  'SELECT public.backfill_pinnacle_mint_acquisitions(50000)'
);

RESET ROLE;
