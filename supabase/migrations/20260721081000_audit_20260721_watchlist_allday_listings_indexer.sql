-- audit_20260721_watchlist_allday_listings_indexer
-- Applied live via MCP 2026-07-21 08:10Z by the nightly autonomous pass; committed for repo parity.
--
-- allday-listings-indexer runs every 15 min (:02/:17/:32/:47 — 21 runs/6h, 286 runs since
-- 2026-07-18, 0 failures) but had NO pipeline_cadence_watchlist row, so
-- detect_stalled_pipelines() was structurally blind to it. Demonstrated live on 2026-07-21:
-- it went silent at 07:17Z during a 9-pipeline scheduler dropout and was the ONLY affected
-- pipeline that produced no stall entry at all.
--
-- severity='medium' is deliberate and matches the listings/offers family convention
-- (allday-listings-retry, allday-offers-indexer, pinnacle-listings-indexer,
-- golazos-sales-indexer are all medium). medium does NOT page --
-- app/api/check-alerts/route.ts:186 dispatches only critical|high. This buys VISIBILITY in
-- detect_stalled_pipelines()/rpc_ops_snapshot(); it does not arm a new pager. Severity
-- calibration is queued separately as CORRELATED-PIPELINE-DROPOUT-DETECTOR.
--
-- 90 min = 6 consecutive missed ticks. Kept deliberately tight: the largest historical gap
-- (75 min) was almost certainly a smaller instance of the same dropout class this row exists
-- to detect, so widening to accommodate it would calibrate the detector against its own target.
--
-- Revert: DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline='allday-listings-indexer';
INSERT INTO public.pipeline_cadence_watchlist
  (pipeline, max_silent_minutes, severity, notes, is_active)
VALUES (
  'allday-listings-indexer',
  90,
  'medium',
  'AllDay on-chain listings indexer. Observed cadence every 15 min at :02/:17/:32/:47 (measured 2026-07-21 over a clean 4h window, 100% ok). 90 min = ~6 missed ticks, matching the allday-offers-indexer convention.',
  true
)
ON CONFLICT (pipeline) DO NOTHING;
