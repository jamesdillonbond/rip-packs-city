-- audit_20261118_zero_yield_two_correct_zeros
--
-- 2026-11-18 ~7:15 PM PT (Claude Code cloud; Sentinel WARN 7:04 PM PT, Trevor: "Keep going. Also make
-- sure these are addressed").
--
-- ZERO-YIELD names two lanes. Both are CORRECT ZEROS, measured today:
--
-- 1. allday-unmapped-atlas-resolver (pg_cron 464, every 5 min; 2,018 runs, last find 11-03). It maps or
--    probes All Day unmapped_sales rows the primary resolver could not name. Its own sampled backlog
--    (extra.open_unresolved at :04/:34) reads 0 on every sample, and an independent count of All Day
--    unmapped_sales with resolved_at IS NULL = 0. Positive control: 1,106 All Day unmapped rows sold in
--    the last 7 days, all 1,106 resolved (newest sold 7:52 AM PT, resolved 8:00 AM PT), so the input is
--    live and the primary resolver clears it first. ~150 ms per run.
-- 2. pack-sales-cursor-unlatch (pg_cron 526, every 10 min; 1,009 runs, last find 11-11). A REPAIR lane:
--    it resets a Top Shot / All Day pack-sales cursor latched done for > 30 min. rows_found = resets.
--    Every recent run reads topshot.was_latched = false and allday.was_latched = false. Its finds have
--    always been ~weekly (10-21, 10-28, 11-04, 11-09, 11-11), so a quiet week trips the 7-day arm by
--    construction. (The walkers are failing on the Dapper Studio 530 now, #218, so neither cursor can
--    latch; the Pack Sales Ingest arms watch that outage separately and stay WARN.)
--
-- REVERT:
--   DELETE FROM public.pipeline_zero_yield_suppressions
--    WHERE pipeline IN ('allday-unmapped-atlas-resolver', 'pack-sales-cursor-unlatch');

DO $mig$
DECLARE v_open int; v_runs int; v_latched int;
BEGIN
  SELECT count(*) INTO v_open FROM public.unmapped_sales
   WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070' AND resolved_at IS NULL;
  IF v_open <> 0 THEN
    RAISE EXCEPTION 'premise false: % open All Day unmapped_sales rows — not a zero', v_open;
  END IF;
  SELECT count(*), count(*) FILTER (WHERE (extra->'topshot'->>'was_latched')::boolean OR (extra->'allday'->>'was_latched')::boolean)
    INTO v_runs, v_latched
    FROM public.pipeline_runs
   WHERE pipeline = 'pack-sales-cursor-unlatch' AND started_at > now() - interval '24 hours';
  IF v_runs < 100 THEN
    RAISE EXCEPTION 'premise false: only % unlatch runs in 24 h (expected ~144)', v_runs;
  END IF;
  IF v_latched <> 0 THEN
    RAISE EXCEPTION 'premise false: % unlatch runs saw a latched cursor in 24 h', v_latched;
  END IF;
END
$mig$;

INSERT INTO public.pipeline_zero_yield_suppressions (pipeline, reason, added_by) VALUES
('allday-unmapped-atlas-resolver',
 'CORRECT ZERO, measured 2026-11-18 ~7:15 PM PT. Its population (All Day unmapped_sales with resolved_at IS NULL) is 0, by its own sampled extra.open_unresolved and by an independent count. Positive control: 1,106 All Day unmapped rows sold in the last 7 days, all resolved by the primary resolver within minutes, so the input is live and simply cleared first. RE-CHECK CONDITION: remove this row if extra.open_unresolved (sampled at :04/:34) reads > 0 for more than a day while rows_found stays 0, or if All Day unmapped rows stop being resolved by anything.',
 'claude-code-cloud session_014vX7Q7NwPJCBF8LrGxniiC'),
('pack-sales-cursor-unlatch',
 'CORRECT ZERO, measured 2026-11-18 ~7:15 PM PT. A repair lane: rows_found = cursors it reset after they sat latched done > 30 min. Every run in the last 24 h reads topshot.was_latched = false and allday.was_latched = false. Its finds have always been about weekly (10-21, 10-28, 11-04, 11-09, 11-11), so a quiet week trips the 7-day arm by construction. RE-CHECK CONDITION: remove this row if any run reads was_latched = true with reset = 0 while the cursor updated_at is more than latched_minutes old (it saw a latch and failed to clear it), or if the lane stops writing runs.',
 'claude-code-cloud session_014vX7Q7NwPJCBF8LrGxniiC')
ON CONFLICT (pipeline) DO UPDATE SET reason = EXCLUDED.reason, added_by = EXCLUDED.added_by;
