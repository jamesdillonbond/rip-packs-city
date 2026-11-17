-- 20260908022949_audit_20260907_promote_unmapped_topshot_sales_hourly
--
-- The DRAIN half of register #67 item (1). The route half (this same commit,
-- app/api/sales-indexer/route.ts Step 6b) starts PARKING Top Shot sales whose
-- edition cannot be resolved at ingest, instead of dropping them and advancing
-- the cursor past their blocks. Parking without a drain would just move the loss
-- into a queue nobody reads — the "instrument nobody keys on" trap — so the two
-- ship together.
--
-- WHY THIS IS A pg_cron JOB AND NOT A CALL FROM THE ROUTE:
-- `/api/sales-indexer` is `maxDuration = 120` and does its work inside an
-- `after()` body, where a kill CANNOT be caught by try/catch. The All Day
-- indexer calls `promote_unmapped_sales` inline, and that function measured
-- **p95 196,353 ms / max 297,164 ms** on the All Day backlog (recorded in
-- promote_unmapped_sales' own concurrency-guard comment, 24 h to 2026-08-29).
-- Calling it from this route would therefore be a latent maxDuration kill that
-- grows in likelihood with the backlog the route itself creates. In the DB it
-- runs under its own timeout with no lambda wall.
--
-- ⚠ IT IS SAFE TO RUN ALONGSIDE THE ALL DAY DRAIN. `promote_unmapped_sales`
-- takes `pg_try_advisory_xact_lock` on a key SCOPED TO p_collection_id, and its
-- own comment records that this scoping is deliberate so that nfl_all_day and
-- laliga_golazos do not serialise against each other. A Top Shot call takes a
-- different key and contends with neither.
--
-- SCHEDULE: `54 * * * *`. Minute 54 was verified to carry ZERO other active
-- pg_cron jobs at migration time (the busiest minutes on this instance are 48
-- with 6 jobs, then 20 and 23 with 5). Hourly rather than All Day's 6x/day
-- because the wmc/`moments` hydrators (jobids 468/469) are actively filling the
-- catalogue these rows resolve against, so a parked row's chance of resolving
-- improves continuously and there is no reason to make it wait four hours.
--
-- EXPECTED VOLUME: measured 2026-09-08 over six consecutive indexer ticks, 41
-- unresolvable sales in ~80 minutes (~740/day), every tick `ok: true` with
-- `gql_resolved: 0` since the GQL host died ~08-28.
--
-- WHY THESE ROWS CAN RESOLVE AT ALL (not an assumption — measured):
-- `unmapped_sales` already holds **24,583 nba_top_shot rows and 24,583 of them
-- are resolved** (the Dec-2025/Jan-2026 cohort, 100%), so this exact path has a
-- perfect record for this collection. `promote_unmapped_sales` resolves via
-- `nft_edition_map`, the `resolution_hint`, or `wallet_moments_cache`.
--
-- anon-exec: none created — this migration creates NO function. It schedules an
-- existing one (`public.promote_unmapped_sales`, already service-role only) via
-- cron.schedule. No ACL is created, changed or reset here.
--
-- REVERT: SELECT cron.unschedule('rpc-topshot-promote-unmapped');
--   Parked rows are harmless if never drained — they sit unresolved in
--   unmapped_sales and nothing reads them as sales. To also stop the parking,
--   revert the route half in the same commit.

SELECT cron.schedule(
  'rpc-topshot-promote-unmapped',
  '54 * * * *',
  $$select public.promote_unmapped_sales('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, 1000);$$
);
