-- audit_20261017_unmapped_hydrate_60_per_tick
-- rpc-topshot-index-unmapped-hydrate: 40 -> 60 ids per run, SAME schedule ('2-58/4').
-- WHY (2026-10-17 11:30 AM PT). After prediction (20261017161643) the actionable backlog sits
-- ~25 k, and one ownership walk (10:26 AM PT) added ~2.4 k actionable ids: at ~8 walks a day
-- that is ~19 k/day in vs 14.4 k/day out at 40/run (ONE data point, not a rate). The
-- 09:24 AM revert (20261017162355) cited the per-call stock counts, now sampled twice an
-- hour (20261017172228).
-- COST. The dispatch SELECT scores every candidate before its top-N sort, so its cost does
-- not depend on p_max: EXPLAIN (ANALYZE, BUFFERS) at LIMIT 120 = 155,391 buffers / 0.67 s.
-- 60/run therefore adds no DB cost and gives 21,600/day. Flow: 24 h of hydrate drains =
-- 360 runs, 0 not-ok, 0 http_429; 17,611 written / 137 no_nft / 122 unmapped. A 60-request
-- burst equals the head lane's, at minute 2 mod 4 (the other Flow bursts sit at 1 and 3
-- mod 4). The drain (topshot_moment_hydrate_drain) has no per-tick cap.
-- REVERT: SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rpc-topshot-index-unmapped-hydrate'),
--           command := 'SELECT public.topshot_index_unmapped_dispatch(40);');
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'rpc-topshot-index-unmapped-hydrate'),
  command := 'SELECT public.topshot_index_unmapped_dispatch(60);');
