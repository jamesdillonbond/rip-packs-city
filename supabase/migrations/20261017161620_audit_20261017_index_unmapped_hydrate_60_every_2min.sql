-- 2026-10-17 (Claude Code cloud). rpc-topshot-index-unmapped-hydrate: 40 per 4 min -> 60 per 2 min.
--
-- WHY. The 10-16 Dune-gap walk queued every unplaced id from 8 newly covered sets. The backlog went
-- 27,111 (10-16) -> 133k (10-17 overnight) -> 173,669 (10-17 9:14 AM PT) and was still rising: 40 ids
-- per 4 min is 14,400 a day, ~12 days to drain with the walk still feeding it. Until an id is hydrated,
-- the ownership index cannot place it, so those holdings are missing from the census.
--
-- CAPACITY, measured over the last 24 h of topshot_moment_hydrate_requests (all lanes): 16,191 answered,
-- 15,924 written / 139 no_nft / 128 unmapped, 0 error, 0 pending. The access node is nowhere near
-- saturated. The constraint is the tick's own comment: keep any one burst under the Flow access node's
-- 100 req/s limit. The other Flow script bursts sit at minute 1 mod 4 (head, 60) and minute 3 mod 4
-- (tick: head 60 + walk 30). This job moves to every even minute (0 and 2 mod 4, never 1 or 3) with a
-- 60-request burst, no larger than the head lane's. 60 per 2 min = 43,200 a day, so the current
-- backlog drains in ~4 days.
--
-- A 429 or other non-200 is drained as outcome 'error' and re-asked after a day (the dispatch's
-- re-ask window), so an over-limit burst delays ids; it cannot drop them. Watch the drain's
-- `http_429` in topshot-moments-hydrate-chain.
--
-- REVERT: SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rpc-topshot-index-unmapped-hydrate'),
--           schedule := '2-58/4 * * * *', command := 'SELECT public.topshot_index_unmapped_dispatch(40);');
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'rpc-topshot-index-unmapped-hydrate'),
  schedule := '*/2 * * * *',
  command  := 'SELECT public.topshot_index_unmapped_dispatch(60);');
