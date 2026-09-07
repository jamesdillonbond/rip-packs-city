-- audit_20260907: retire the cadence-watchlist row for offers-sweep.
-- Its cron-job.org entry (job 7712610 "RPC Offers Sweep") was set INACTIVE 2026-09-07 02:5xZ via the
-- console (Trevor: "use chrome if you need to, including for cron job"): the Top Shot marketplace
-- GraphQL host it reads has answered 530 since ~08-28, and every tick since logged
-- `ok=true, skipped: upstream_outage`. Its two outputs are fed elsewhere now: edition_offers.low_ask
-- from Atlas (20260907022120 / 024130) and highest_offer from the on-chain topshot-offers-indexer
-- (job 7735311, alive) plus Atlas for verified editions (024130). Without this row the watchlist
-- would page 'silence' 120 min after the last tick. Note kept; row inactive.
-- REVERT: UPDATE public.pipeline_cadence_watchlist SET is_active = true WHERE pipeline = 'offers-sweep';
--   and re-enable job 7712610 in the console.
UPDATE public.pipeline_cadence_watchlist
   SET is_active = false,
       notes = '[RETIRED 2026-09-07 — cron-job.org job 7712610 set INACTIVE; the GQL host answers 530 since ~08-28 and the sweep logged ok=true skipped every tick. low_ask now from Atlas (sync_edition_offers_from_atlas), highest_offer from topshot-offers-indexer + Atlas verified editions.] ' || COALESCE(notes, '')
 WHERE pipeline = 'offers-sweep';
