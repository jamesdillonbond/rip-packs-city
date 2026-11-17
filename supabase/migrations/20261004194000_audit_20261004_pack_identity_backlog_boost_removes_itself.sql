-- 2026-10-04 (PT) — the temporary identity-backlog boost (20261004193500, pg_cron 705) removes itself
-- once pack_nft_identity_queue is empty, so it cannot outlive the backlog unattended.
-- cron.schedule with the same jobname keeps jobid 705 and replaces only the command. Only the
-- chosen CASE branch is evaluated: while the queue has rows it dispatches 5 × 100; on the first tick
-- with an empty queue it unschedules itself.
--
-- REMOVE early: SELECT cron.unschedule('rpc-pack-identity-backlog-boost');

SELECT cron.schedule(
  'rpc-pack-identity-backlog-boost',
  '2-57/5 * * * *',
  'SELECT CASE WHEN EXISTS (SELECT 1 FROM public.pack_nft_identity_queue) THEN public.dispatch_pack_nft_identity(5, 100, NULL)::text ELSE cron.unschedule(''rpc-pack-identity-backlog-boost'')::text END'
);
