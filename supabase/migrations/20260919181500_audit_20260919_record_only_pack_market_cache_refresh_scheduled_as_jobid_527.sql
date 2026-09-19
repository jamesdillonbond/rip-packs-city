-- audit_20260919_record_only_pack_market_cache_refresh_scheduled
--
-- RECORD-ONLY. One `execute_sql` pg_cron change, which writes no
-- `schema_migrations` row. (Precedent: `20260826063100`.)
--
--   SELECT cron.schedule('rpc-pack-market-sales-cache-refresh',
--                        '7,22,37,52 * * * *',
--                        $$SELECT public.refresh_pack_market_sales_cache(60, 45);$$);
--   -- assigned jobid 527, owner `postgres`, applied 2026-09-19 ~18:06Z
--
-- Minutes are off :00/:15/:30/:45 deliberately - `max_worker_processes = 6`
-- against `cron.max_running_jobs = 32` makes the round minutes a live
-- worker-slot starvation source on this box.
--
-- ⭐ WHY 15 MINUTES AND NOT FASTER, WHICH IS THE COUNTER-INTUITIVE PART:
-- a cache only pays if it refreshes LESS often than its pages render. Measured
-- 2026-09-19: ~19,500 renders/day across 5,880 pack pages is ~3.3
-- renders/page/day, and a refresh costs about what a render costs (408 ms/dist,
-- same per-dist aggregate). Refreshing more than ~3x/day would therefore spend
-- MORE IO than the renders it replaces. At 60 dists / 15 min over a 5,520-dist
-- roster this is ~1 full cycle/day: ~11 GB/day against the ~39 GB/day of live
-- aggregation removed, and every page becomes a single-row lookup regardless.
-- ⚠ THAT TRADE DEPENDS ON THE RENDER RATE. Re-derive it before speeding this
-- job up; a slower crawler makes the cache MORE favourable, a faster one less.
--
-- REVERT: SELECT cron.unschedule('rpc-pack-market-sales-cache-refresh');

DO $$
DECLARE v_sched text;
BEGIN
  SELECT schedule INTO v_sched FROM cron.job
   WHERE jobname = 'rpc-pack-market-sales-cache-refresh';

  IF v_sched IS NULL THEN
    -- WARNING, not EXCEPTION: a database rebuilt from migrations has no pg_cron
    -- estate, and failing there would make the history unreplayable for a
    -- reason that is not a defect.
    RAISE WARNING 'rpc-pack-market-sales-cache-refresh is not scheduled - pack_market_sales_cache '
                  'will go stale and get_pack_market_row silently returns to the 33 s live path '
                  '(see 20260919180521)';
  END IF;
END $$;
