-- Three Zero-Yield arm rows re-derived 2026-09-19 6:50 PM PT (Cowork cloud), each a CORRECT ZERO
-- with a measured positive control and a RE-CHECK CONDITION, in the shape of the four rows already
-- in pipeline_zero_yield_suppressions (allday-price-recover, topshot-buyer-backfill-historical,
-- match-topshot-players, offers-sweep). A suppression here silences the arm's warn for the lane;
-- it changes nothing about the lane itself. Applied via the Supabase MCP; this file commits as usual.
-- REVERT: DELETE FROM public.pipeline_zero_yield_suppressions
-- WHERE pipeline IN ('pinnacle-sales-history-backfill','golazos-sales-indexer','sales-seller-recovery-dune');

INSERT INTO public.pipeline_zero_yield_suppressions (pipeline, reason, added_at, added_by) VALUES
('pinnacle-sales-history-backfill',
 'CORRECT ZERO, measured 2026-09-19 6:50pm PT. The lane is PARKED AT THE SPORK FLOOR by design: every run since 09-12 returns extra.note = reached_spork_floor_hint with extra.next = "deeper history (<2025-12-29) needs spork-proxy", cursor_after is FROZEN at 137390146 across consecutive runs, and each run costs ~250-400 ms. Pre-Mainnet-24 Flow history is unreachable by construction (memory: flow-spork-boundary-65264619), so "found nothing" means "nothing reachable", not "failed to look". RE-CHECK CONDITION: remove this row the day a run shows extra.note <> reached_spork_floor_hint OR cursor_after moves below 137390146 (a spork proxy arrived and the lane can walk again) - from then on a zero IS a stall.',
 now(), 'cowork-cloud session_01DgSv2pJTLiLpVeQ9Haobji'),
('golazos-sales-indexer',
 'CORRECT ZERO, measured 2026-09-19 6:50pm PT. The chain reader is LIVE and the market is EMPTY: cursor_after advances every tick (165101626 -> 165103124 -> 165104620 -> 165106123 -> 165106770 across the last four runs, ~1,500 blocks per tick), and every tick SEES events - extra.raw_v1_events 11-19 (all v1_non_golazos) and extra.raw_v2_dapper_events 25-169 - so the instrument is reading the chain (positive control) and finding no Golazos sales. Golazos sells in BURSTS: sales table shows 5 on 08-31, 16 on 09-10, 38 on 09-12, then nothing to 09-19 - a thin market with ~10-day gaps, consistent with the ledger''s "genuinely market-limited" finding (2026-08-13). The Sales Ingest by Collection arm''s >168h warn is the same reading and stays visible; this row only stops the Zero-Yield arm double-counting it. RE-CHECK CONDITION: remove this row if extra.v1_filtered_in > 0 or extra.cadence_resolved > 0 while rows_written stays 0 (Golazos events SEEN but not WRITTEN = a real stall), or if cursor_after stops advancing.',
 now(), 'cowork-cloud session_01DgSv2pJTLiLpVeQ9Haobji'),
('sales-seller-recovery-dune',
 'CONFIGURED STOP, NOT A STALL, measured 2026-09-19 6:50pm PT. The Dune Spend arm reads EXHAUSTED: the cycle cap is spent (103.5% of datapoints at 87% of the cycle, sales-seller-recovery-dune = 1,034,812 dp) and every Dune lane paces at 0 until the reset in ~4 days. A lane whose budget is deliberately zero finds nothing by design. RE-CHECK CONDITION: this row EXPIRES with the Dune cycle - remove it once the Dune Spend arm reads a fresh cycle (on or after 2026-09-24); if the lane still finds nothing after the reset with datapoints being spent, that is a real zero and the arm should see it.',
 now(), 'cowork-cloud session_01DgSv2pJTLiLpVeQ9Haobji');

DO $$
BEGIN
  IF (SELECT count(*) FROM public.pipeline_zero_yield_suppressions
       WHERE pipeline IN ('pinnacle-sales-history-backfill','golazos-sales-indexer','sales-seller-recovery-dune')) <> 3 THEN
    RAISE EXCEPTION 'suppression rows not landed';
  END IF;
END $$;
