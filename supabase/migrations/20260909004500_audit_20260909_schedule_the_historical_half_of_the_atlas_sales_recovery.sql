-- 20260909004500_audit_20260909_schedule_the_historical_half_of_the_atlas_sales_recovery
--
-- The 30-day FMV window is already drained by hand (6,589 rows; HIGH+MEDIUM editions 4,301 -> 4,726,
-- +9.9%; falsifiers 0 same-day duplicates / 0 revived #68 deletions). What remains is ~74,297 sales
-- from 2020-10-01 onward that are OUTSIDE the confidence window.
--
-- WHY STILL WORTH IT: they never re-enter the 30-day window, so they do NOT move FMV confidence --
-- but per-edition sales history is USER-FACING on edition and Moment pages, and those pages are
-- currently missing real sales we already hold. This is completeness, not accuracy.
--
-- WHY PACED RATHER THAN BLASTED: this instance is IO-bound and `sales` is heavily indexed and
-- partitioned, so 74k inserts in one go is exactly the shape that causes a saturation spell. 1,500
-- rows / 10 min is ~9k/hour, draining in ~8 h at a load the estate absorbs without a spike.
--
-- ⚠ RETIRE IT WHEN IT READS ZERO -- this is a one-shot backfill, not a standing lane, and a job that
-- writes 0 forever is the null-instrument shape this repo keeps paying for. Check:
--   SELECT extra->>'remaining' FROM pipeline_runs
--    WHERE pipeline='topshot-sales-atlas-backfill' ORDER BY started_at DESC LIMIT 1;
-- then:  SET LOCAL ROLE cron_heavy; SELECT cron.unschedule('rpc-topshot-sales-atlas-backfill'); RESET ROLE;
--
-- ⚠ Forward traffic is NOT this job's business: `sync_sales_from_atlas` (jobid 471) already handles
-- new events, and its ±10 min guard is correct there (0 of 8,854 rows have a ±10 min twin). This job
-- only ever sees the historical residue.
--
-- REVERT: DELETE FROM public.sales WHERE collection='nba_top_shot' AND source='atlas_backfill';
-- (plus unschedule above). The distinct source keeps this migration's writes separable from the
-- live lane's 'atlas' rows.

SET LOCAL ROLE cron_heavy;

SELECT cron.schedule('rpc-topshot-sales-atlas-backfill', '7-57/10 * * * *',
  'SELECT public.backfill_topshot_sales_from_atlas_events(1500)');

RESET ROLE;
