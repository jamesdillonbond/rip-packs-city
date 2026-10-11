-- audit_20261011_completed_offers_backfill_cursors_bounded_suppressions
--
-- 2026-10-11 ~7:45 AM PT (Claude Code; queued by the 10-11 night pass, handoff QUEUED #2).
--
-- WHAT PAGED. get_pipeline_alerts() carries `cursor_stalled · high · topshot_offers_history_backfill`
-- (frozen since 10-10 6:49 PM PT at block 167,374,370), and since 10-11 12:07 AM PT also
-- `topshot_missing_fill_offers_walk` (frozen since 10-10 11:07 PM PT at block 167,393,791).
--
-- WHY IT IS A FALSE POSITIVE. Both are ONE-TIME, MANUALLY dispatched walks (GHA
-- topshot-offers-history-backfill.yml, workflow_dispatch only; no pg_cron, no cron-job.org) that
-- each reported done=true on their last run:
--   backfill-topshot-offers               done=true, inserted 0 (all already_present), STOP_AT 167.4M
--   backfill-topshot-missing-fill-offers  done=true 06:07Z, inserted 0, matched_missing 0
-- (the second cursor sits ~6.2k blocks under its STOP_AT because the walk caps at the sealed
-- height it read, and it read done=true there). Nothing will ever advance either cursor again, so the
-- 6 h age arm pages forever. The LIVE offers lanes are the ones that matter and are current:
-- event_cursor topshot_offers (live indexer) and topshot_offer_fill_backfill (trailing re-walk).
--
-- WHAT THIS DOES. Two BOUNDED suppressions (expire 2027-04-30), worded "Completed backfill" — the
-- convention of topshot_pack_opens_backfill / topshot_pack_purchases_backfill — and deliberately NOT
-- in the words check_suppression_parked_claim_drift() keys on (no floor claim: these are done, not
-- floored). Each row carries the predicate that justifies it. Not a threshold change.
--
-- REVERT: DELETE FROM public.pipeline_alert_suppression
--          WHERE pipeline IN ('topshot_offers_history_backfill','topshot_missing_fill_offers_walk');
--   (a DELETE through the MCP is held for confirmation — run it from the SQL editor.)

INSERT INTO public.pipeline_alert_suppression (pipeline, reason, added_at, expires_at)
VALUES
(
  'topshot_offers_history_backfill',
  'Completed backfill — one-time manual walk /api/admin/backfill-topshot-offers (GHA topshot-offers-history-backfill.yml, workflow_dispatch only; no schedule anywhere) reported done=true on 2026-10-10 6:49 PM PT with the cursor at block 167374370, inserted 0 (every offer already present). Nothing advances this cursor again, so cursor_stalled would page forever. PREDICATE (re-check, do not trust this text): (1) event_cursor topshot_offers (the LIVE indexer) updated within 30 min; (2) the latest pipeline_runs row for backfill-topshot-offers has extra.done=true. If the walk is re-dispatched and moves this cursor, re-read its last run before keeping this row. Added 2026-10-11 ~7:45 AM PT, migration audit_20261011_completed_offers_backfill_cursors_bounded_suppressions.',
  now(),
  '2027-04-30 07:00:00+00'
),
(
  'topshot_missing_fill_offers_walk',
  'Completed backfill — one-time manual walk /api/admin/backfill-topshot-missing-fill-offers (same dispatch-only GHA workflow, mode input; no schedule anywhere) reported done=true on 2026-10-10 11:07 PM PT with the cursor at block 167393791 (it caps at the sealed height it read, under its STOP_AT 167400000), matched_missing 0 on its final page. Nothing advances this cursor again. PREDICATE (re-check, do not trust this text): (1) event_cursor topshot_offers (the LIVE indexer) updated within 30 min; (2) the latest pipeline_runs row for backfill-topshot-missing-fill-offers has extra.done=true. If re-dispatched, re-read its last run before keeping this row. Added 2026-10-11 ~7:45 AM PT, migration audit_20261011_completed_offers_backfill_cursors_bounded_suppressions.',
  now(),
  '2027-04-30 07:00:00+00'
)
ON CONFLICT (pipeline) DO UPDATE
  SET reason = EXCLUDED.reason, added_at = EXCLUDED.added_at, expires_at = EXCLUDED.expires_at;

DO $mig$
DECLARE v_drift jsonb; v_live timestamptz; v_done text; v_alerts jsonb;
BEGIN
  IF (SELECT count(*) FROM public.pipeline_alert_suppression
       WHERE pipeline IN ('topshot_offers_history_backfill','topshot_missing_fill_offers_walk')) <> 2 THEN
    RAISE EXCEPTION 'expected 2 suppression rows';
  END IF;
  -- predicate (1): the live lane is live
  SELECT updated_at INTO v_live FROM public.event_cursor WHERE id = 'topshot_offers';
  IF v_live IS NULL OR v_live < now() - interval '30 minutes' THEN
    RAISE EXCEPTION 'predicate (1) false: topshot_offers cursor is %', v_live;
  END IF;
  -- predicate (2): each walk's LAST run said done
  SELECT extra->>'done' INTO v_done FROM public.pipeline_runs
   WHERE pipeline = 'backfill-topshot-offers' ORDER BY started_at DESC LIMIT 1;
  IF v_done IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'predicate (2) false for backfill-topshot-offers: last done=%', v_done;
  END IF;
  SELECT extra->>'done' INTO v_done FROM public.pipeline_runs
   WHERE pipeline = 'backfill-topshot-missing-fill-offers' ORDER BY started_at DESC LIMIT 1;
  IF v_done IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'predicate (2) false for backfill-topshot-missing-fill-offers: last done=%', v_done;
  END IF;
  -- the parked-claim drift guard must not flag these rows
  v_drift := public.check_suppression_parked_claim_drift();
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_drift) e
              WHERE e->>'pipeline' IN ('topshot_offers_history_backfill','topshot_missing_fill_offers_walk')) THEN
    RAISE EXCEPTION 'suppression drift guard flags a new row: %', v_drift;
  END IF;
END
$mig$;
