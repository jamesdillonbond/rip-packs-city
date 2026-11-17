-- audit_20261030_zero_yield_suppress_pinnacle_dist_names_between_drops
--
-- 2026-10-30 (PT, Claude Code cloud, session_014vX7Q7qM7twrBUY9w4M9yP). check_zero_yield_lanes flags
-- pinnacle-pack-dist-names-onchain (found_baseline 1, 60 runs / 0 found in 7 d). It is an EVENT-DRIVEN
-- namer: it only has work when a collector opens a pack from a Pinnacle distribution we have no row for,
-- or a row is untitled. Measured 10:29 AM PT:
--   untitled Pinnacle pack_distributions rows = 0 (of 160);
--   dists referenced by pinnacle_pack_opens in 14 d with no row = 0;
--   positive control: the opens ingester is healthy (pinnacle-pack-opens-ingest 192/192 ok in 48 h,
--   ~3,000 events re-swept per run) and its SOURCE's own head is 10-23 8:19 AM PT, equal to our newest
--   open; weekly opens 1,336 / 1,375 / 414 (week of 10-05, the Halloween drop) then 3 / 0 — no new drop.
-- So zero yield is "no new Pinnacle drop", not a broken lane.
--
-- Premises re-asserted at apply time; a false one aborts.
--
-- REVERT: DELETE FROM public.pipeline_zero_yield_suppressions WHERE pipeline = 'pinnacle-pack-dist-names-onchain';

DO $mig$
DECLARE v_untitled bigint; v_missing bigint;
BEGIN
  SELECT count(*) INTO v_untitled FROM public.pack_distributions
   WHERE collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714' AND title IS NULL;
  IF v_untitled > 0 THEN
    RAISE EXCEPTION 'premise false: % untitled Pinnacle pack_distributions rows', v_untitled;
  END IF;
  SELECT count(DISTINCT o.dist_id) INTO v_missing FROM public.pinnacle_pack_opens o
   WHERE o.opened_at > now() - interval '14 days' AND o.dist_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.pack_distributions pd
                      WHERE pd.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714' AND pd.dist_id = o.dist_id);
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'premise false: % opened Pinnacle dists have no pack_distributions row', v_missing;
  END IF;
END
$mig$;

INSERT INTO public.pipeline_zero_yield_suppressions (pipeline, reason, added_by) VALUES
('pinnacle-pack-dist-names-onchain',
 'IDLE BETWEEN DROPS, measured 2026-10-30 10:29 AM PT. Event-driven namer: work exists only when a Pinnacle pack is opened from a distribution with no row, or a row is untitled. Untitled rows 0/160; opened-but-missing dists (14 d) 0. Positive control: pinnacle-pack-opens-ingest 192/192 ok in 48 h and its source head (10-23 8:19 AM PT) equals our newest open; weekly opens fell 1,375 -> 414 (Halloween drop) -> 3 -> 0. RE-CHECK CONDITION: remove this row if any pinnacle_pack_opens row references a dist with no pack_distributions row, or an untitled Pinnacle row exists, while rows_found stays 0.',
 'claude-code-cloud session_014vX7Q7qM7twrBUY9w4M9yP')
ON CONFLICT (pipeline) DO UPDATE SET reason = EXCLUDED.reason, added_by = EXCLUDED.added_by;
