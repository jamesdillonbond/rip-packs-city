-- audit_20261125_retire_two_stale_zero_yield_suppressions
--
-- Applied 2026-11-26 (Trevor: "Apply it"; held since 11-25 ~8:30 PM PT, inbox
-- docs/overnight/inbox/2026-11-26T0432Z-claude-code-held-delete-two-stale-zero-yield-suppressions.md).
-- Two pipeline_zero_yield_suppressions rows whose OWN re-check conditions are met, re-measured at apply:
--   · ufc-enrichment-drain ("remove the day it writes any new pipeline_runs row"): 4 runs / 114 written in 72 h,
--     last 3:48 AM PT 11-26 (backstop caller since ded424306).
--   · pack-pull-source-rip-id-backfill ("remove if extra.examined > 0"): 144 runs in 72 h, examined 12,976,
--     written 12,976, last 8:11 AM PT 11-26.
-- Neither lane is flagged today, so no current Sentinel reading changes; the rows only hid a future stall.
--
-- REVERT (the two rows exactly as they were):
-- INSERT INTO public.pipeline_zero_yield_suppressions (pipeline, reason, added_at, added_by) VALUES
--  ('pack-pull-source-rip-id-backfill', 'DRAINED BACKLOG, measured 2026-10-19 ~7:35 AM PT. The RPC''s whole population (pack_pull moment_acquisitions with source_pack_rip_id NULL and no pack_pull_rip_backfill_attempts row) = 0; every run reports examined 0. Positive control: 20,526 pack_pull rows acquired in the last 8 days, 20,526 already linked at write time, so new pulls never reach this lane. Last find 10-11 (223 written). RE-CHECK CONDITION: remove this row if that population goes non-zero (extra.examined > 0) while exact_match + inferred stays 0, or if recent pack_pull rows start landing with source_pack_rip_id NULL.', '2026-10-19 14:39:28.398337+00', 'claude-code-cloud session_01Y8XikWBzgFf8d4j8efJWfJ'),
--  ('ufc-enrichment-drain', 'RETIRED, measured 2026-10-23 ~8:10 AM PT. The lane''s cron-job.org caller was disabled 2026-10-18; last pipeline_runs row 2026-10-18 14:07Z (7:07 AM PT), 0 runs since (5 days). It flags only because its 7-day window still holds 125 pre-retirement runs (10-16..10-18), every one rows_written 0 - in the week before retirement it found 96 rows/day and wrote none (all skipped, cadence_errors = rows_found), i.e. it was a non-writing lane, which is why it was retired. RE-CHECK CONDITION: remove this row the day ufc-enrichment-drain writes any new pipeline_runs row (the lane was re-enabled) - from then on a zero IS a stall. candy-sales-indexer is deliberately NOT suppressed: its zero is #58 (OpenSea key / Magic Eden feed) and must stay visible.', '2026-10-23 14:59:28.114742+00', 'cowork-cloud 2026-10-23 attended (Trevor: "look for any sql work")');

DELETE FROM public.pipeline_zero_yield_suppressions
 WHERE pipeline IN ('ufc-enrichment-drain', 'pack-pull-source-rip-id-backfill');
