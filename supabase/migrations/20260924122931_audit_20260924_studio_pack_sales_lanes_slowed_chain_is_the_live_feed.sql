-- audit_20260924_studio_pack_sales_lanes_slowed_chain_is_the_live_feed
--
-- The Top Shot / All Day studio pack-sales lanes ran every 3 min with a
-- 30-page budget (≈1,200 Dapper GraphQL calls/hour between them). Measured
-- 2026-09-24: over 8 h, 320 runs wrote almost nothing new (e.g. 22:18–22:42 PT:
-- rows_written 0 on 14 of 15 runs) — the sweep re-walks history the table
-- already holds. And since 20260924122325/122704/122827 the live pack-sales
-- surfaces read pack_purchases (on-chain, every marketplace, ingested a median
-- 7 min after the sale). The studio index is now history + a second source of
-- dist ids, which a 15-min (Top Shot) / 30-min (All Day) cadence with a 10-page budget serves: the head
-- still walks until a page brings nothing new (≤ 10 pages ≈ 1,000 rows per
-- 15 min, above the ~20 studio rows/hour observed).
--
-- REVERT:
--   SELECT cron.schedule('rpc-topshot-pack-sales-backfill', '1-58/3 * * * *',
--     $$ SELECT net.http_get(url:='https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/backfill-topshot-pack-sales?key=' || public.cron_gate_key('backfill-topshot-pack-sales') || '&pages=30', timeout_milliseconds:=55000); $$);
--   SELECT cron.schedule('rpc-allday-pack-sales-backfill', '*/3 * * * *',
--     $$ SELECT net.http_get(url:='https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/backfill-allday-pack-sales?key=' || public.cron_gate_key('backfill-allday-pack-sales') || '&pages=30', timeout_milliseconds:=55000); $$);

SELECT cron.schedule('rpc-topshot-pack-sales-backfill', '4,19,34,49 * * * *',
  $$ SELECT net.http_get(url:='https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/backfill-topshot-pack-sales?key=' || public.cron_gate_key('backfill-topshot-pack-sales') || '&pages=10', timeout_milliseconds:=55000); $$);

SELECT cron.schedule('rpc-allday-pack-sales-backfill', '5,35 * * * *',
  $$ SELECT net.http_get(url:='https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/backfill-allday-pack-sales?key=' || public.cron_gate_key('backfill-allday-pack-sales') || '&pages=10', timeout_milliseconds:=55000); $$);

-- The cadence watchlist was seeded for a 3-minute lane (20 min silent / 45 min
-- without success). Re-derive for the new cadence: ~2.5 missed ticks.
-- REVERT: UPDATE ... SET max_silent_minutes = 20, max_minutes_without_success = 45 for both.
UPDATE public.pipeline_cadence_watchlist
   SET max_silent_minutes = 40, max_minutes_without_success = 90,
       notes = notes || ' 2026-09-24: cadence 3 -> 15 min (chain pack_purchases is the live sales feed); bounds re-derived.'
 WHERE pipeline = 'topshot-pack-sales-ingest';
UPDATE public.pipeline_cadence_watchlist
   SET max_silent_minutes = 75, max_minutes_without_success = 150,
       notes = notes || ' 2026-09-24: cadence 3 -> 30 min (chain pack_purchases is the live sales feed); bounds re-derived.'
 WHERE pipeline = 'allday-pack-sales-ingest';
