-- audit_20261104_topshot_sold_floor_clear_schedule
--
-- 2026-11-04 PT. Second half of audit_20261104_topshot_sold_listings_close_and_floor_clear (the function and its
-- tables): the cadence-watchlist row and the pg_cron schedule. Split out so the function lands first and is called
-- once by hand before the schedule starts. Revert: docs/audits/2026-11-04-topshot-sold-floor-clear-revert.sql.

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active, max_minutes_without_success)
VALUES ('ts-sold-floor-clear', 25, 'medium',
  'pg_cron rpc-ts-sold-floor-clear at 5,10,15,25,30,35,45,50,55: closes Top Shot Atlas listing events whose NFT sold after listed_at, NULLs edition_offers floors whose NFT sold after low_ask_confirmed_at, and dispatches 6 Atlas edition re-verifies for cleared editions. rows_found = sold floors found this tick, rows_written = listings closed + floors cleared. Added 2026-11-04 (14 % of Top Shot asks were proven-sold).',
  true, 45)
ON CONFLICT (pipeline) DO NOTHING;

SELECT cron.schedule('rpc-ts-sold-floor-clear', '5,10,15,25,30,35,45,50,55 * * * *', 'SELECT public.close_sold_topshot_listings_and_floors(10000, 6);');
