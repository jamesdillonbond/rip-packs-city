-- audit_20261017 — seed ownership-walk candidates HOURLY, not only daily.
--
-- Cause: seed_topshot_ownership_walk_candidates (20261015224833) runs once a day (jobid 737,
-- '17 9 * * *' UTC = 2:17 AM PT, 60-day window). A collector who opens their first pack or
-- makes their first buy waits up to ~24 h to be seeded, and only then gets walked — so on a
-- launch day (Series 2026-27 tips off 2026-10-20) brand-new holders of brand-new editions are
-- missing from topshot_ownership for most of a day.
-- Evidence (2026-10-17 10:19 AM PT): 35 pack openers + 49 marketplace buyers from the last
-- 24 h were not yet in the index; the 1-day window of both legs costs ~0.29 s / ~12k
-- buffers (EXPLAIN ANALYZE). The walk has headroom: ~800 wallets x ~8 runs/day vs a
-- 400-day peak of 1,259 distinct openers in a day.
-- Change: an hourly job with a 2-day window (overlap absorbs a missed tick). The daily
-- 60-day job stays as the backstop. Same function, no body change.
-- Revert: SELECT cron.unschedule('rpc-topshot-ownership-walk-candidates-hourly');
SELECT cron.schedule('rpc-topshot-ownership-walk-candidates-hourly', '41 * * * *',
  $$SELECT public.seed_topshot_ownership_walk_candidates(2);$$);
