-- 2026-09-30 (PT) — the four every-minute Flow REST lanes no longer fire
-- together at :00; each gets its own 15-second slot in the minute.
--
-- Inbox 2026-09-29T2110Z (pg_net 429 surge), re-measured 7:35 AM PT 09-30:
-- ~1,000 `pg_net_http_429`/hour for the last 6 h, all `server: envoy`
-- (rest-mainnet.onflow.org's limiter), and 88-92 % of them land in the first
-- 5 seconds of a minute. Jobs 635/636/639/645 all start at :00.2 and each
-- queues its node calls in the same instant; pg_net (batch_size 200) sends
-- them together and the burst trips the node's per-second limit.
--
-- Each lane runs well under its slot (last 2 h: p50 0.05-0.73 s, max 17.5 s
-- on 636, max <= 8.7 s on the rest), so an offset of 0 / 15 / 30 / 45 s
-- keeps every run inside its minute. `FROM pg_sleep(n)` keeps the command a
-- single statement (no transaction block); the lane's calls are queued after
-- the sleep and sent on commit, i.e. at the offset.
--
-- Side effect worth having: with one lane per 15-second window, a 429's
-- second-of-minute names its lane, which `net._http_response` could not do
-- (the lanes delete their request ids once collected).
--
-- Revert: re-run each cron.schedule below with the bare command
--   'SELECT public.run_<lane>();'  (schedule unchanged, '* * * * *').

SELECT cron.schedule('rpc-chain-arrival-lane',       '* * * * *', 'SELECT public.run_chain_arrival_lane();');
SELECT cron.schedule('rpc-pinnacle-pull-chain-lane', '* * * * *', 'SELECT public.run_pinnacle_pull_chain_lane() FROM pg_sleep(15);');
SELECT cron.schedule('rpc-topshot-pull-chain-lane',  '* * * * *', 'SELECT public.run_topshot_pull_chain_lane() FROM pg_sleep(30);');
SELECT cron.schedule('rpc-pinnacle-opener-lane',     '* * * * *', 'SELECT public.run_pinnacle_opener_lane() FROM pg_sleep(45);');
