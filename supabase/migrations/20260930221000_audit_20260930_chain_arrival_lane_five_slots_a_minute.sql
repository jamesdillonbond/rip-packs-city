-- 2026-09-30 (PT) — run_chain_arrival_lane gets four more slots a minute
-- (:08 / :23 / :38 / :53), beside its :00 run.
--
-- Measured 3:10 PM PT: 37,190 probes still bisecting, 31,945 of them on
-- mainnet26 in 7,985 intervals with ~25 halvings each left (~200k calls). At
-- 24 calls a node a minute that is ~6 days; mainnet24 (2,059 intervals) ~33 h.
-- The node's limit is a per-SECOND burst, not a per-minute budget: three
-- bursts of 20 trivial scripts to mainnet26 at :13, :15 and :17 returned 60/60
-- 200s, while the lane's one :00 burst of 24 draws ~10 % 429s (last 4 h:
-- 317-357 an hour). So the node sits idle ~59 s of every minute.
--
-- Each extra slot is its own job with `FROM pg_sleep(n)` (one statement, no
-- transaction block; calls go out on commit, at the offset), 7 s clear of the
-- :00 / :15 / :30 / :45 slots the other Flow lanes hold
-- (20260930143000), so a 429's second-of-minute still names its lane. The
-- lane takes its advisory lock, so two runs never overlap, and a probe with a
-- call in flight is never re-dispatched. It runs in ~0.9 s (p50, last hour).
-- The function is unchanged: <= 24 calls per node per run.
--
-- Revert: SELECT cron.unschedule(j) FROM unnest(ARRAY['rpc-chain-arrival-lane-08',
--   'rpc-chain-arrival-lane-23', 'rpc-chain-arrival-lane-38', 'rpc-chain-arrival-lane-53']) j;

SELECT cron.schedule('rpc-chain-arrival-lane-08', '* * * * *', 'SELECT public.run_chain_arrival_lane() FROM pg_sleep(8);');
SELECT cron.schedule('rpc-chain-arrival-lane-23', '* * * * *', 'SELECT public.run_chain_arrival_lane() FROM pg_sleep(23);');
SELECT cron.schedule('rpc-chain-arrival-lane-38', '* * * * *', 'SELECT public.run_chain_arrival_lane() FROM pg_sleep(38);');
SELECT cron.schedule('rpc-chain-arrival-lane-53', '* * * * *', 'SELECT public.run_chain_arrival_lane() FROM pg_sleep(53);');
