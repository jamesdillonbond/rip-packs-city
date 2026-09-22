-- audit_20260922_two_zero_yield_lanes_are_correct_zeros_with_positive_controls
--
-- check_zero_yield_lanes() flagged four lanes on 2026-09-22 (alerts-send, alerts-dispatch,
-- golazos-listings-indexer, wmc-fmv-populate-pgcron-backstop). Two are CORRECT ZEROS, each proven
-- with a positive control, and get the house-shape suppression (reason + re-check condition).
-- The two alert lanes are NOT suppressed: their zero is a real product limit (deal alerts on Top
-- Shot can only fire for asks confirmed inside 12 h, and only 1,485 of 13,154 TS asks are) and
-- must stay visible.
--
-- REVERT: DELETE FROM public.pipeline_zero_yield_suppressions
--         WHERE pipeline IN ('golazos-listings-indexer','wmc-fmv-populate-pgcron-backstop');

INSERT INTO public.pipeline_zero_yield_suppressions (pipeline, reason, added_by) VALUES
('golazos-listings-indexer',
 'CORRECT ZERO, measured 2026-09-22 12:45pm PT. The chain reader is LIVE and the market is SILENT: cursor_after advances ~1,125 blocks per 15-min tick and every tick sees 200-300 storefront events (extra.events_pre_filter), none Golazos (v2_dapper_typeids_seen never includes .Golazos.NFT). Positive control ON CHAIN, same 5,000-block window (~70 min): A.87ca73a41bb50ad5.Golazos.Withdraw = 0 and .Deposit = 0, against TopShot.Withdraw = 1,084 and AllDay.Withdraw = 113 (Flow REST /v1/events). No Golazos NFT moved at all, so no listing event can exist. Same reading as the 09-19 golazos-sales-indexer row. RE-CHECK CONDITION: remove this row if Golazos.Withdraw/Deposit events reappear on chain while events_post_filter stays 0, or if cursor_after stops advancing.',
 'cowork-cloud session_013PZaei6yfY72mt7tW5EnAh'),
('wmc-fmv-populate-pgcron-backstop',
 'BACKSTOP STOOD DOWN BY DESIGN, measured 2026-09-22 12:44pm PT. This lane only does work when the HTTP primary (wmc-fmv-populate) goes silent; every recent run reports verdict = http_caller_alive_stood_down, took_over = false, http_silent_minutes = 1, and writes under its own name on purpose. Positive control: the primary is healthy - wmc-fmv-populate ran 1,554 times on 09-22 by 11 AM PT, 0 failures, 5,142 rows written. A backstop that never has to take over finds nothing. RE-CHECK CONDITION: remove this row if any run shows took_over = true with rows_fmv 0 (it took over and failed), or if wmc-fmv-populate itself goes zero-yield or silent.',
 'cowork-cloud session_013PZaei6yfY72mt7tW5EnAh');

DO $$
BEGIN
  IF (SELECT count(*) FROM public.pipeline_zero_yield_suppressions
       WHERE pipeline IN ('golazos-listings-indexer','wmc-fmv-populate-pgcron-backstop')) <> 2 THEN
    RAISE EXCEPTION 'suppressions not written';
  END IF;
END $$;
