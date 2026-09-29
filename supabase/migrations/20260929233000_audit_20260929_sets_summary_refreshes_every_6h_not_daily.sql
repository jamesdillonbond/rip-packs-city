-- 2026-09-29 (PT): sets_summary (the materialized view get_set_detail resolves set pages from) refreshes
-- 4x a day instead of once. Panini editions now arrive continuously (742 in two days, 29 products admitted
-- 09-29): Panini sets went 62 -> 285, but the view still held 62, so every new set's page 404'd and the
-- sitemap listed ~223 dead /panini-blockchain/set/* URLs until the next daily refresh (found by the 09-29
-- mobile sweep: 3 of 3 sampled set URLs 404). A manual refresh brought it to 285 and get_set_detail resolves
-- all three. Cost: REFRESH ... CONCURRENTLY, 16.2-16.4 s per run measured (jobid 37, 09-27..09-29), readers
-- not blocked; 4 runs/day = ~65 s/day. Same minute as before (:50), hours 1/7/13/19 UTC.
-- Revert: SELECT cron.alter_job(37, schedule => '50 7 * * *');
SELECT cron.alter_job(37, schedule => '50 1,7,13,19 * * *');
