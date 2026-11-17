-- 2026-10-17 (Claude Code cloud). REVERT of 20261017161620: rpc-topshot-index-unmapped-hydrate back to
-- 40 per 4 min ('2-58/4').
--
-- WHY. 20261017161620 tripled the rate to drain a 173,669-id backlog. 23 s later 20261017161643 (another
-- session) made the dispatch skip ids predicted into sets the index excludes on purpose, and the actionable
-- backlog fell to 23,409: about 1.6 days at the old rate, so the faster schedule no longer buys anything
-- that matters. It did double the DATABASE cost. Each call's backlog count probes `moments` and
-- `topshot_moment_id_editions` for every one of the ~187 k queue rows: 1.61 M blocks / ~3.5 s per call
-- (pgss, 7 calls after 16:05 UTC). At every 2 min that is ~1.15 billion blocks a day, the largest
-- consumer on the estate. The rate is not where the cost is; the per-call count is.
-- REVERT (re-applies the faster rate): SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname =
--   'rpc-topshot-index-unmapped-hydrate'), schedule := '*/2 * * * *',
--   command := 'SELECT public.topshot_index_unmapped_dispatch(60);');
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'rpc-topshot-index-unmapped-hydrate'),
  schedule := '2-58/4 * * * *',
  command  := 'SELECT public.topshot_index_unmapped_dispatch(40);');
