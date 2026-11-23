-- Top Shot sales whose edition is not yet mapped are PARKED in unmapped_sales by the sales
-- indexer and reach `sales` only through two HOURLY jobs: 476 topshot_resolve_unmapped_via_atlas
-- (:50) then 474 promote_unmapped_sales (:54). Measured 2026-11-23 8:30-11:00 AM PT, after the
-- indexer moved to every 5 min (cron-job.org, Trevor 11-23): Top Shot on-chain sale-ingest lag
-- p50 3.2 min but p90 47 min, and EVERY sale > 20 min late was ingested at :54 (~28 % of them).
-- The indexer interval cannot move that tail; this cadence can.
--
-- Cost: 476 avg 0.4 s / max 2 s, 474 avg 2.1 s / max 24 s, 0 failures in 48 h. 476's Atlas
-- probes are capped at 12 per run AND stamped per nft for 14 days, so a faster cadence makes the
-- same ~110 probes/day happen sooner, not more of them. All Day's twin resolver (job 464) already
-- runs every 5 min. Lane budget: no job added (schedule change only).
-- Off :X5/:X0 (pg_cron launcher blackout) and off :X6 (heavy-minute IO pressure, 11-22 read);
-- promote runs 2 min after resolve so a tick's newly mapped rows promote in the same cycle.
-- Revert: SELECT cron.alter_job(476, schedule := '50 * * * *'); SELECT cron.alter_job(474, schedule := '54 * * * *');
SELECT cron.alter_job(476, schedule := '7-59/10 * * * *');
SELECT cron.alter_job(474, schedule := '9-59/10 * * * *');
