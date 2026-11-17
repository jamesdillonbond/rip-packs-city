-- 2026-10-18 12:33 PM PT (Cowork cloud; Trevor "Keep going. Don't stop until you've completely exhausted your capabilities").
-- check_zero_yield_lanes() lists three lanes every pass that are CORRECT zeros, each re-derived
-- today with an instrument independent of the lane. Suppressed with an explicit re-check
-- condition (the table's convention), so the arm stops re-flagging them and a real break still
-- has a named trigger. topshot-set-series-onchain is deliberately NOT suppressed: it finds only
-- NEW Top Shot sets, and the Series 2026-27 tip-off (10-20) is exactly when its zero must show.
-- REVERT: remove these three rows from public.pipeline_zero_yield_suppressions.
INSERT INTO public.pipeline_zero_yield_suppressions (pipeline, reason, added_by) VALUES
('pinnacle-pack-openers',
 'CORRECT ZERO, measured 2026-10-18 ~12:15 PM PT. Nobody has opened a Disney Pinnacle pack since 10-09. Independent on-chain count, Flow REST /v1/events A.edf9df96c92f4595.PackNFT.Opened in 250-block ranges: 10-10 00:00 PT -> 10-18 12:30 PM PT = 0 events (3,681 ranges, 0 failed reads). Positive control, same script: 10-08..10-09 PT = 414 events, all on 10-09 = exactly the lane''s 414 attributed opens that day (0 on 10-08). Pack opens are bursty (377 on 10-01, 306 on 10-02, 0 10-03..08, 414 on 10-09). RE-CHECK CONDITION: remove this row if PackNFT.Opened events appear on chain for a day on which this lane writes 0 rows.',
 'cowork-cloud session_01KW9MiKsV8WvJGPVovaH65y'),
('pinnacle-metadata-backfill',
 'CORRECT ZERO, measured 2026-10-18 ~12:15 PM PT. It writes only for newly opened Pinnacle pins, and there have been none: A.edf9df96c92f4595.PackNFT.Opened = 0 events on chain 10-10 -> 10-18 (same read as the pinnacle-pack-openers row, positive control 414 on 10-09). The 10-17 night pass found it actively scanning (q3_pass rising) with 0 errors. RE-CHECK CONDITION: remove this row if pinnacle-pack-openers writes rows on a day this lane writes 0, or if its runs report errors.',
 'cowork-cloud session_01KW9MiKsV8WvJGPVovaH65y'),
('chain-arrival-flips',
 'DRAINED BACKLOG, measured 2026-10-17 6:14 PM PT and re-read 2026-10-18 ~12:20 PM PT: chain_arrival_flip_reads = 13,009 done + 2,115 skipped, 0 in any open state; every run ok since 10-11 with 0 collected/enqueued/dispatched; 0 eligible probes lack a flip read (the 10-17 positive control). RE-CHECK CONDITION: remove this row if chain_arrival_flip_reads gains a row in a non-terminal status that stays for more than a day, or if a seeded probe is eligible but has no flip read.',
 'cowork-cloud session_01KW9MiKsV8WvJGPVovaH65y');
