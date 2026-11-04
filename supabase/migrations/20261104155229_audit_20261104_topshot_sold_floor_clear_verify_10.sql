-- audit_20261104_topshot_sold_floor_clear_verify_10
--
-- 2026-11-04 ~7:55 AM PT. rpc-ts-sold-floor-clear (jobid 825) re-verify budget 6 -> 10 per tick. Measured on the first
-- two ticks: 1,908 sold floors cleared, 168 refilled by ts-listings-atlas-sync within 5 min, 11 of 12 Atlas edition
-- probes answered 200 (1 still in flight), 0 x 403; the first 6 verified editions all carry a fresh live ask again.
-- At 6/tick the ~1,740 still-NULL editions take ~32 h; at 10/tick ~19 h. Per-5-min Atlas probe load across the
-- edition-verify lanes goes from ~13 to ~17 (the 2026-09-26 burst that drew 403s was 30 at once).
-- Revert: SELECT cron.alter_job(825, command := 'SELECT public.close_sold_topshot_listings_and_floors(10000, 6);');

SELECT cron.alter_job(825, command := 'SELECT public.close_sold_topshot_listings_and_floors(10000, 10);');
