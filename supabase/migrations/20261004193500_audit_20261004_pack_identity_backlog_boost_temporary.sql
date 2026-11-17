-- 2026-10-04 (PT) — TEMPORARY second dispatcher for the pack_nft_identity backlog.
--
-- WHY. 64,930 disputed Top Shot packs were queued at 9:27 AM PT for chain identity (inbox
-- 2026-10-04T1627Z-…). The lane (pg_cron 509, run_pack_nft_identity_lane: 3 batches × 100 per 5 min)
-- moves ~2.6 k/h, so ~57.5 k left at 11:30 AM PT is ~20 h. In the 3 h to 11:33 AM PT all 139 of its
-- requests to Dapper's searchPackNft answered 200 with no throttling, so there is headroom.
--
-- WHAT. One extra pg_cron job at 2-57/5 (between the lane's 3-58/5 ticks; avoids :00/:01/:20/:21/
-- :40/:41) that dispatches 5 more batches of 100 while the queue is non-empty. It is a no-op once
-- the queue is empty. dispatch_pack_nft_identity pops with FOR UPDATE SKIP LOCKED, so two
-- dispatchers never take the same ids, and the lane's collect_pack_nft_identity collects every
-- request regardless of which job sent it. No function is changed. Expected: ~8 batches per 5 min,
-- ~9.6 k/h, so the backlog clears in ~6–7 h.
--
-- REMOVE when pack_nft_identity_queue is empty (or on any sign of throttling):
--   SELECT cron.unschedule('rpc-pack-identity-backlog-boost');

SELECT cron.schedule(
  'rpc-pack-identity-backlog-boost',
  '2-57/5 * * * *',
  'SELECT public.dispatch_pack_nft_identity(5, 100, NULL) WHERE EXISTS (SELECT 1 FROM public.pack_nft_identity_queue)'
);
