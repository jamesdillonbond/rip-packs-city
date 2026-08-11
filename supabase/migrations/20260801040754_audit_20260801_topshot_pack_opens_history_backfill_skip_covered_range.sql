-- topshot-pack-opens-history-backfill walks DOWNWARD from its cursor toward
-- floor 27,341,470, at ~2.42M blocks/day (97 runs/24h, 14,015 tx fetched/24h).
-- It sat at 95,090,659, which is 33,160,313 blocks ABOVE the oldest known TS rip
-- (61,930,346 / 2023-09-29) -- i.e. ~13.7 days of scanning ground already fully
-- covered by the July history haul, at real egress + compute cost, for nothing.
--
-- SAFE TO SKIP, on two independent checks:
--   1. Coverage 61,930,346..95,090,659 is dense and contiguous -- all 33 buckets
--      populated, min 344 rips, avg 8,053, total 265,747. No holes.
--   2. Empirically: 97 consecutive runs over the last 24h scanned this exact
--      territory and wrote ZERO rips.
--
-- Advancing the cursor to the frontier puts it on genuinely unexplored ground
-- (below 61,930,346) immediately instead of in ~2 weeks. The remaining unknown --
-- whether TopShot PackNFT even emitted opens before 2023-09-29 -- is now answered
-- in days rather than a fortnight, and answering it is the point of this job.
--
-- REVERT: UPDATE public.event_cursor SET last_processed_block = 95090659
--         WHERE id = 'topshot_pack_opens_history_backfill';
UPDATE public.event_cursor
   SET last_processed_block = 61930346,
       updated_at = now()
 WHERE id = 'topshot_pack_opens_history_backfill'
   AND last_processed_block > 61930346;