-- 2026-11-14 ~8:30 PM PT. sol_usd_daily had no rows for 2026-07-01 → 08-01: sol_usd_daily_tick()
-- reads a rolling 100-day CoinGecko window and the table was started ~11-10, so July was never in reach.
-- The Candy legacy backfill re-walk (audit_20261115_candy_legacy_sales_high_water_rewind) brings July
-- sales into the drain, which prices each sale at its trade day's rate.
-- Values: CoinGecko /coins/solana/market_chart/range points ON 00:00 UTC (the tick's exact basis,
-- ms % 86400000 < 60000), fetched from the Cowork container. Cross-checked: Kraken SOLUSD daily open,
-- 32/32 days, median |diff| 0.02 %, max 0.07 %; DC3-wiki sale-time implied rate within ±3 %.
-- ON CONFLICT DO NOTHING: never overwrites a tick-written day.
-- Revert: DELETE FROM public.sol_usd_daily WHERE source = 'coingecko_range_backfill_20261115';
insert into public.sol_usd_daily (day, usd, source, captured_at)
select d::date, u, 'coingecko_range_backfill_20261115', now() from (values
('2026-07-01',73.564819),('2026-07-02',77.361477),('2026-07-03',80.619651),('2026-07-04',82.291231),('2026-07-05',81.703497),('2026-07-06',81.515631),('2026-07-07',81.888431),('2026-07-08',80.586014),('2026-07-09',77.788863),('2026-07-10',77.992193),('2026-07-11',78.068786),('2026-07-12',76.715623),('2026-07-13',76.869852),('2026-07-14',74.931283),('2026-07-15',77.808648),('2026-07-16',77.238648),('2026-07-17',75.269247),('2026-07-18',75.002003),('2026-07-19',75.481055),('2026-07-20',76.311804),('2026-07-21',77.748861),('2026-07-22',78.088245),('2026-07-23',77.939264),('2026-07-24',75.851348),('2026-07-25',73.907767),('2026-07-26',74.477115),('2026-07-27',76.690202),('2026-07-28',74.143059),('2026-07-29',73.772257),('2026-07-30',73.611245),('2026-07-31',74.463049),('2026-08-01',72.794983)
) v(d,u)
on conflict (day) do nothing;