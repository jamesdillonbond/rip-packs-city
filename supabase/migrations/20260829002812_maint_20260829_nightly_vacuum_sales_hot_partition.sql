-- Nightly VACUUM (ANALYZE) of the hot `sales` partition.
--
-- WHY. /api/analytics/sales/leaderboard failed 20 of 26 production requests in
-- the 24 h to 2026-08-28 23:06Z (10 of 10 in the last 6 h) with
-- `canceling statement due to statement timeout`. Root cause measured
-- 2026-08-29 00:00-00:30Z: the l30 leaderboard scan is an Index Only Scan on
-- idx_sales_2026_pulse_window that was doing 66,218 HEAP FETCHES, because the
-- visibility map over the recent-30-day slice of sales_2026 was stale.
--
-- The discriminator (same index, same query shape, near-identical row count):
--   sold_at 60-90d ago  : 115,200 rows, 15,089 buffers, 10,616 heap fetches,  716 ms
--   sold_at last 30d    : 117,076 rows, 74,754 buffers, 66,218 heap fetches, 4,970-9,530 ms
-- After VACUUM, the same production-shape query: 28,928 buffers, 0 heap fetches,
-- 2,466 ms; and analytics_sales_leaderboard() called AS THE FUNCTION with the
-- production payload went 16,300 ms -> 2,303-2,961 ms. A 10-request production
-- sweep (5 collections x 2 roles) then returned 10/10 HTTP 200, against 0/10
-- six hours earlier.
--
-- ⚠ MECHANISM NOT FULLY ESTABLISHED, deliberately recorded as such. sales_2026
-- ALREADY carries tuned autovacuum reloptions (insert_threshold=2000,
-- insert_scale_factor=0.01 => fires about every 3 days) and autovacuum had run
-- 11 times, most recently 08-24. So "autovacuum never fires" is REFUTED and is
-- not the explanation. A first plain VACUUM moved heap fetches only
-- 66,218 -> 54,923; a second one ~10 min later (with DISABLE_PAGE_SKIPPING, and
-- after the heavy EXPLAIN scans had drained) took them to 0. Those two runs
-- differed in BOTH the flag and the xmin horizon, so the flag is NOT shown to be
-- the operative variable. This job is therefore a low-cost hedge, not a proven
-- mechanism fix.
--
-- FALSIFIER: re-run the l30 EXPLAIN (ANALYZE, BUFFERS) 24-48 h from now. If
-- Heap Fetches has climbed back above ~10,000 with this job running nightly,
-- a plain VACUUM is insufficient -- escalate to DISABLE_PAGE_SKIPPING, and
-- re-open the question of why autovacuum leaves the recent slice dirty.
--
-- Slot: 10:20 UTC = 03:20 PT. Hour 10 UTC carries only 1 other scheduled job
-- and sits outside both the user-traffic peak and the 1am-PT nightly pass.
--
-- REVERT: select cron.unschedule('maint-vacuum-sales-hot-partition');

select cron.unschedule('maint-vacuum-sales-hot-partition')
where exists (select 1 from cron.job where jobname = 'maint-vacuum-sales-hot-partition');

select cron.schedule(
  'maint-vacuum-sales-hot-partition',
  '20 10 * * *',
  $job$VACUUM (ANALYZE) public.sales_2026$job$
);
