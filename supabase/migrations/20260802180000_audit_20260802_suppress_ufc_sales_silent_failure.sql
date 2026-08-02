-- audit_20260802_suppress_ufc_sales_silent_failure
--
-- Applied to prod 2026-08-02 via Supabase MCP; this file is the repo record.
-- Consolidates the original INSERT and its two subsequent reason corrections
-- (audit_20260802_correct_ufc_sales_suppression_causation and
-- audit_20260802_correct_ufc_suppression_coverage_gap) into the final state.
--
-- WHY: the `silent_failure` arm of get_pipeline_alerts() fires CRITICAL -- a
-- PAGING severity -- for cursor_id 'ufc_sales' whenever silent_indexer_failures
-- reports status='silent_failure', computed as "0 runs in the last hour AND 0
-- sales AND 0 unmapped". Measured 2026-08-02 across the full 73h pipeline_runs
-- retention window: ufc-sales-indexer logged 44 runs spread over only 42 of 73
-- hours, so 31 of 73 hours (42.5%) contain zero runs and the arm reads
-- silent_failure roughly 4 hours in every 10. It paged at 05:15 PT and had
-- flipped back to instrumented_empty by 17:44Z -- it FLAPS. A critical arm that
-- is wrong 42.5% of the time trains the operator to ignore the tier that real
-- outages page on.
--
-- The condition is not a fault: both venues for UFC-on-Flow secondary trading
-- are closed, and the indexer itself is healthy (44 runs, 44 ok, last 17:44Z).
--
-- ⚠ TWO FACTUAL CORRECTIONS from Trevor, both folded into the reason text --
-- earlier drafts of this suppression asserted both errors:
--   1. CAUSATION. Not "the Aptos migration on 2026-05-13". Two separate
--      closures: UFC Strike's own studio/native marketplace feed ends
--      2025-08-07, and the residual Flowty secondary venue ended 2026-05-13
--      with the Flowty marketplace-frontend shutdown.
--   2. COVERAGE. An earlier draft claimed "zero sales for eight months" between
--      those feeds as a MARKET fact. It is an INGEST-WINDOW artifact:
--        source='ufc_studio_history_v1'   813,380 rows 2022-02-15..2025-08-07
--        source='onchain'                      53 rows 2026-04-18..2026-05-13
--        source='flowty_archive_extractor'      2 rows 2026-04-11
--      On-chain UFC indexing did not begin until ~2026-04-11, so nothing
--      observed the interval. Flowty's UFC secondary market was active for
--      YEARS and is essentially absent from `sales`. flowty_transactions cannot
--      fill it (that scanner ran only 2026-04-25..2026-05-24 for EVERY
--      collection; UFC: 8 rows), and ufc-sales-history-backfill is parked at the
--      spork retention floor 137390146 where V1 history is pruned from public
--      Flow REST (404) -- the pre-floor portion is very likely UNRECOVERABLE.
--      Treat UFC secondary volume, and any UFC FMV derived from it, as a FLOOR,
--      not a census.
--
-- WHY SUPPRESSION AND NOT A THRESHOLD CHANGE: the genuine signal inside this arm
-- is "the indexer stopped running entirely", and that is ALREADY carried by the
-- pipeline_cadence_watchlist row for ufc-sales-indexer (is_active=true,
-- max_silent_minutes=240, severity=info), which the 2026-07-11 night pass kept
-- expressly "to preserve a loose >4h total-stop signal". This removes a
-- redundant, chronically-wrong CRITICAL duplicate, not the coverage.
--
-- BOUNDED 180d, NOT permanent -- mirroring the reasoning already written into
-- the `unmapped-sales-ufc_strike` suppression rather than the permanent
-- `ufc_listings` one (that indexer is fully RETIRED, is_active=false). Lapses
-- 2027-01-29 and forces a re-look.
--
-- REVERT:
--   DELETE FROM public.pipeline_alert_suppression WHERE pipeline = 'ufc_sales';

INSERT INTO public.pipeline_alert_suppression (pipeline, reason, added_at, expires_at)
VALUES (
  'ufc_sales',
  'UFC-on-Flow secondary trading is closed TODAY, but read the coverage caveat below before treating any UFC sales figure as a market census. Corrected twice on 2026-08-02 by Trevor. (a) CAUSATION: not "the Aptos migration on 2026-05-13". Two separate closures — UFC Strike''s own studio/native marketplace feed ends 2025-08-07, and the residual Flowty secondary venue ended 2026-05-13 with the Flowty marketplace-frontend shutdown. (b) COVERAGE: an earlier version of this reason claimed "zero sales for eight months" between them as a market fact. WRONG — it is an INGEST-WINDOW artifact. sales.source breaks down as ufc_studio_history_v1 = 813,380 rows 2022-02-15..2025-08-07; onchain = 53 rows 2026-04-18..2026-05-13; flowty_archive_extractor = 2 rows 2026-04-11. RPC''s UFC history is almost entirely UFC''s own studio platform, and on-chain UFC indexing did not start until ~2026-04-11, so nothing observed the interval between the two feeds. Flowty''s UFC secondary market was active for YEARS and is absent from `sales` almost entirely; flowty_transactions cannot fill it (that scanner only ran 2026-04-25..2026-05-24 for every collection, UFC: 8 rows), and ufc-sales-history-backfill is parked at the spork retention floor 137390146 where V1 history is pruned from public Flow REST (404), so the pre-floor portion is very likely unrecoverable. ⚠ Treat UFC secondary volume and any UFC FMV derived from it as a FLOOR, not a census. WHY SUPPRESSED ANYWAY: the silent_failure arm of get_pipeline_alerts() fires CRITICAL/paging on "0 runs in 1h AND 0 sales AND 0 unmapped"; over the full 73h pipeline_runs retention ufc-sales-indexer logged 44 runs across only 42 of 73 hours, so 31/73 hours (42.5%) read silent_failure. It paged 05:15 PT 2026-08-02 and was back to instrumented_empty by 17:44Z — it FLAPS, and a critical arm wrong 42.5% of the time trains the operator to ignore the paging tier. The indexer is healthy (44 runs, 44 ok). The genuine "indexer stopped entirely" signal is NOT lost: the pipeline_cadence_watchlist row for ufc-sales-indexer (is_active=true, 240min, info) was kept by the 2026-07-11 night pass expressly "to preserve a loose >4h total-stop signal". BOUNDED 180d rather than permanent (unlike ufc_listings, whose indexer is fully RETIRED); lapses 2027-01-29, forcing a re-look. Revert: DELETE FROM public.pipeline_alert_suppression WHERE pipeline = ''ufc_sales'';',
  now(),
  now() + interval '180 days'
)
ON CONFLICT (pipeline) DO UPDATE
  SET reason = EXCLUDED.reason,
      expires_at = EXCLUDED.expires_at;
