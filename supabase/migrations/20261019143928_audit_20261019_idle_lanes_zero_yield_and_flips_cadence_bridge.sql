-- audit_20261019_idle_lanes_zero_yield_and_flips_cadence_bridge
--
-- 2026-10-19 ~7:40 AM PT (Claude Code cloud; sentinel WARN 7:04 AM PT, Trevor: "work on addressing
-- anything you can from this").
--
-- (1) ZERO-YIELD: two lanes are DRAINED, re-derived today with a read independent of each lane.
--   * pack-pull-source-rip-id-backfill — the RPC's whole population (pack_pull rows with no
--     source_pack_rip_id and no prior attempt) is 0. Positive control: 20,526 pack_pull rows
--     acquired in the last 8 days, 20,526 already linked (the writer links them at insert).
--   * pack-rips-chain-rekey — 0 rips and 0 purchases disagree with their chain identity across
--     the WHOLE pack_nft_identity table (the lane only looks at the last hour). Positive control:
--     4,667 Top Shot identity rows were checked in the last hour, so its input is flowing.
--   topshot-set-series-onchain stays unsuppressed on purpose (20261018193353: the Series 2026-27
--   tip-off is when its zero must show).
--
-- (2) CADENCE: chain-arrival-flips was gated on 10-17 (20261018011453: runs every 10 min unless a
--   read is pending or a candidate waits), so 720/day -> 144/day by design. The arm compares a
--   12 h window with the MEDIAN of runs/day over [today-17, today-3), which holds 720/day until
--   at least 8 post-gate days (10-18 onward) are inside it, i.e. from 10-29. A dated bridge that
--   lapses on its own on 10-30; Pipeline Silence (max_silent 20 min) still watches the lane, and
--   its zero-yield row (20261018193353) carries its own re-check condition.
--
-- REVERT:
--   DELETE FROM public.pipeline_zero_yield_suppressions
--    WHERE pipeline IN ('pack-pull-source-rip-id-backfill', 'pack-rips-chain-rekey');
--   DELETE FROM public.cadence_exempt_lanes WHERE pipeline_pattern = 'chain-arrival-flips';

DO $mig$
DECLARE v_unattempted bigint; v_rip_mis bigint; v_pur_mis bigint; v_ident_1h bigint; v_flip_runs int; v_flip_ok int;
BEGIN
  -- premises must hold at apply time
  SELECT count(*) INTO v_unattempted
    FROM public.moment_acquisitions ma
   WHERE ma.acquisition_method = 'pack_pull' AND ma.source_pack_rip_id IS NULL
     AND ma.wallet IS NOT NULL AND ma.acquired_date IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.pack_pull_rip_backfill_attempts a
                      WHERE a.nft_id = ma.nft_id AND a.wallet = ma.wallet AND a.acquired_date = ma.acquired_date);
  IF v_unattempted > 0 THEN
    RAISE EXCEPTION 'premise false: % unattempted unlinked pack_pull rows', v_unattempted;
  END IF;

  SELECT count(*) INTO v_rip_mis
    FROM public.pack_nft_identity i
    JOIN public.pack_rips r ON r.pack_nft_id = i.pack_nft_id AND r.collection_id = i.collection_id
   WHERE i.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND i.dist_id IS NOT NULL AND i.dist_id <> '0' AND r.dist_id IS NOT NULL AND i.dist_id <> r.dist_id
     AND EXISTS (SELECT 1 FROM public.pack_distributions d WHERE d.collection_id = i.collection_id AND d.dist_id = i.dist_id);
  SELECT count(*) INTO v_pur_mis
    FROM public.pack_nft_identity i
    JOIN public.pack_purchases p ON p.pack_nft_id = i.pack_nft_id AND p.collection_id = i.collection_id
   WHERE i.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND i.dist_id IS NOT NULL AND i.dist_id <> '0' AND p.pack_dist_id IS NOT NULL AND i.dist_id <> p.pack_dist_id
     AND EXISTS (SELECT 1 FROM public.pack_distributions d WHERE d.collection_id = i.collection_id AND d.dist_id = i.dist_id);
  IF v_rip_mis > 0 OR v_pur_mis > 0 THEN
    RAISE EXCEPTION 'premise false: % rip / % purchase chain-identity mismatches', v_rip_mis, v_pur_mis;
  END IF;

  SELECT count(*) INTO v_ident_1h FROM public.pack_nft_identity
   WHERE checked_at > now() - interval '1 hour' AND collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  IF v_ident_1h = 0 THEN
    RAISE EXCEPTION 'premise false: no Top Shot pack identity checked in the last hour (rekey input not flowing)';
  END IF;

  SELECT count(*), count(*) FILTER (WHERE ok) INTO v_flip_runs, v_flip_ok
    FROM public.pipeline_runs
   WHERE pipeline = 'chain-arrival-flips' AND started_at > now() - interval '6 hours';
  IF v_flip_runs < 30 OR v_flip_ok < v_flip_runs THEN
    RAISE EXCEPTION 'premise false: chain-arrival-flips ran % (% ok) in 6 h, expected ~36 all ok', v_flip_runs, v_flip_ok;
  END IF;
END
$mig$;

INSERT INTO public.pipeline_zero_yield_suppressions (pipeline, reason, added_by) VALUES
('pack-pull-source-rip-id-backfill',
 'DRAINED BACKLOG, measured 2026-10-19 ~7:35 AM PT. The RPC''s whole population (pack_pull moment_acquisitions with source_pack_rip_id NULL and no pack_pull_rip_backfill_attempts row) = 0; every run reports examined 0. Positive control: 20,526 pack_pull rows acquired in the last 8 days, 20,526 already linked at write time, so new pulls never reach this lane. Last find 10-11 (223 written). RE-CHECK CONDITION: remove this row if that population goes non-zero (extra.examined > 0) while exact_match + inferred stays 0, or if recent pack_pull rows start landing with source_pack_rip_id NULL.',
 'claude-code-cloud session_01Y8XikWBzgFf8d4j8efJWfJ'),
('pack-rips-chain-rekey',
 'CORRECT ZERO, measured 2026-10-19 ~7:35 AM PT. The lane rekeys rips/purchases whose dist disagrees with a chain identity checked in the last hour; across the WHOLE pack_nft_identity table there are 0 such rips and 0 such purchases. Positive control: 4,667 Top Shot identity rows checked in the last hour, so its input is live and simply agrees. Last find 10-11 (94,142, the one-time attribution sync). RE-CHECK CONDITION: remove this row if the whole-table rip or purchase mismatch count (the premise query in 20261019143928) goes non-zero for more than a day, or if pack_nft_identity stops being checked.',
 'claude-code-cloud session_01Y8XikWBzgFf8d4j8efJWfJ')
ON CONFLICT (pipeline) DO UPDATE SET reason = EXCLUDED.reason, added_by = EXCLUDED.added_by;

INSERT INTO public.cadence_exempt_lanes (pipeline_pattern, reason, evidence, review_by)
VALUES (
  'chain-arrival-flips',
  'Cadence deliberately cut 5x on 2026-10-17 (20261018011453: run only on a pending read or waiting candidate, else every 10 min). The 14 d baseline median still holds the pre-gate every-2-min rate, so the arm reads a planned change as a collapse. Bridge only: lapses when the baseline is clean.',
  'Measured 2026-10-19 ~7:35 AM PT: pipeline_runs_daily = 720/day 10-04..10-17, 174 on 10-18, 144 in the last 24 h, all ok, rows_written 0 (drained backlog, zero-yield row 20261018193353). Arm baseline = MEDIAN over [today-17, today-3); it drops to the gated rate once >= 8 post-gate days (10-18+) are inside, i.e. from 10-29.',
  DATE '2026-10-30'
)
ON CONFLICT (pipeline_pattern) DO UPDATE
  SET reason = EXCLUDED.reason, evidence = EXCLUDED.evidence, review_by = EXCLUDED.review_by;
