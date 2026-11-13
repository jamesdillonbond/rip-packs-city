-- audit_20261112_schedule_allday_best_offer_daily — applied 2026-11-12 6:58 PM PT in the dashboard SQL editor
-- (Trevor 6:58 PM PT: "You run it in chrome. Keep going"), after the MCP refused cron.schedule from the session.
-- No schema_migrations row for this name. Both statements are idempotent (cron.schedule upserts on jobname; the
-- watchlist insert is guarded), so re-running this file changes nothing.
--
-- pg_cron jobid 871: capture_allday_best_offers() once a day at 13:20 UTC (5:20 AM PT) — one row per NFL All Day
-- edition per PT day into allday_best_offer_daily (20261113012004). Bid history for backtesting bid-aware pricing on
-- All Day; nothing prices from it. Read from cron.job at ship: nothing else starts at 13:20 UTC except the every-minute / every-2-minute lanes
-- (nearest: jobid 642 at 13:19).
-- anon-exec: no function is created here.
-- Revert: select cron.unschedule('rpc-capture-allday-best-offers');
select cron.schedule('rpc-capture-allday-best-offers', '20 13 * * *', $c$select public.capture_allday_best_offers()$c$);

insert into public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, notes, is_active)
select 'allday-best-offer-daily', 1560, 3000, 'info', 'Added 2026-11-12: capture_allday_best_offers() (pg_cron 871, 20 13 UTC daily) writes one row per All Day edition per PT day into allday_best_offer_daily - bid history for backtesting bid-aware pricing. ok=false when the open-offer book is empty or the write raises. Nothing prices from it.', true
where not exists (select 1 from public.pipeline_cadence_watchlist where pipeline = 'allday-best-offer-daily');
