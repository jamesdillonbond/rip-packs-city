-- audit_20261014_golazos_sales_v1_backfill_finished_suppression_made_permanent
--
-- 2026-10-14 ~6:56 PM PT (Claude Code cloud; Trevor: "Keep going").
--
-- WHAT PAGED. get_pipeline_alerts() raised `cursor_stalled · high · golazos_sales_v1_backfill`
-- ("Cursor updated 14 days ago at block 137390146") the moment this row's bounded suppression
-- lapsed at 2026-10-15 00:00Z (5:00 PM PT 10-14).
--
-- WHY THIS IS THE ROW'S OWN PRESCRIBED ACTION, NOT A NEW DECISION. Migration
-- 20260914153000 bounded the row to 2026-10-15 because the walk was still descending, and wrote
-- the lapse instruction into the reason: "ON LAPSE 2026-10-15, RE-DERIVE RATHER THAN RENEW: if
-- last_processed_block = 137,390,146 the walk finished — make this row permanent with a reason
-- that says so. If it is still above the floor, the walk stalled or rewound again and THAT is the
-- finding."
--
-- RE-DERIVED 2026-10-14 ~6:50 PM PT:
--   event_cursor golazos_sales_v1_backfill  last_processed_block = 137,390,146 (= SPORK_FLOOR_HINT),
--                                          updated 2026-09-30 5:34 PM PT (the ETA the row predicted)
--   golazos-sales-history-backfill          8 runs / 8 ok every day 09-27 -> 10-14 (pipeline_runs_daily);
--                                          every run in retention: rows 0, note "reached_spork_floor_hint",
--                                          next "deeper history (<2025-12-29) needs spork-proxy"
-- So the walk FINISHED at the floor. The guard check_suppression_parked_claim_drift() reads the
-- floor this reason opens with (137390146) and finds cursor <= floor: clean.
--
-- REVERT: UPDATE public.pipeline_alert_suppression SET expires_at = '2026-10-15 00:00:00+00'
--   WHERE pipeline = 'golazos_sales_v1_backfill';  (the previous reason text is verbatim in
--   20260914153000, section 2a; it is not needed to revert the expiry). Through the MCP an
--   UPDATE may be held for confirmation: run it from the SQL editor.

DO $pre$
DECLARE v_block bigint; v_ok int; v_runs int;
BEGIN
  SELECT last_processed_block INTO v_block FROM public.event_cursor WHERE id = 'golazos_sales_v1_backfill';
  IF v_block IS DISTINCT FROM 137390146 THEN
    RAISE EXCEPTION 'precondition false: golazos_sales_v1_backfill cursor is %, not the floor 137390146', v_block;
  END IF;
  SELECT count(*) FILTER (WHERE ok), count(*) INTO v_ok, v_runs FROM public.pipeline_runs
   WHERE pipeline = 'golazos-sales-history-backfill' AND started_at > now() - interval '24 hours';
  IF v_runs = 0 OR v_ok <> v_runs THEN
    RAISE EXCEPTION 'precondition false: parent lane golazos-sales-history-backfill % ok of % runs in 24 h', v_ok, v_runs;
  END IF;
END
$pre$;

UPDATE public.pipeline_alert_suppression
   SET expires_at = NULL,
       reason = 'Parked at the spork retention floor 137,390,146 because the walk FINISHED there, '
         || 'verified on lapse, not assumed. RE-DERIVED 2026-10-14 ~6:50 PM PT, the day the bounded row (20260914153000) lapsed: '
         || 'event_cursor.last_processed_block = 137,390,146 = SPORK_FLOOR_HINT (app/api/cron/golazos-sales-history-backfill/route.ts), '
         || 'reached 2026-09-30 5:34 PM PT, the ETA that row predicted from 320,000 blocks/day. '
         || 'The parent lane golazos-sales-history-backfill ran 8/8 ok every day 09-27 -> 10-14 and every run in retention logs rows 0, '
         || 'note "reached_spork_floor_hint", next "deeper history (<2025-12-29) needs spork-proxy": V1 history below the floor is pruned from public Flow REST, '
         || 'so this backward cursor never moves again by design. The 09-14 row named this as the case to make permanent. '
         || 'WHAT STILL WATCHES THE LANE: pipeline_cadence_watchlist golazos-sales-history-backfill (a total stop) and the failure_rate arm (hyphenated name); '
         || 'the LIVE Golazos sales cursor is golazos_sales, unaffected. '
         || 'IF THIS CURSOR EVER MOVES (a spork-proxy walk, a manual reset), re-read it: check_suppression_parked_claim_drift() flags a cursor above the floor this reason claims. '
         || 'Migration audit_20261014_golazos_sales_v1_backfill_finished_suppression_made_permanent.'
 WHERE pipeline = 'golazos_sales_v1_backfill';

DO $post$
DECLARE v_n int; v_drift jsonb; v_alerts int;
BEGIN
  SELECT count(*) INTO v_n FROM public.pipeline_alert_suppression
   WHERE pipeline = 'golazos_sales_v1_backfill' AND expires_at IS NULL;
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected the row to be permanent, found %', v_n; END IF;
  v_drift := public.check_suppression_parked_claim_drift();
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_drift) e WHERE e->>'pipeline' = 'golazos_sales_v1_backfill') THEN
    RAISE EXCEPTION 'parked-claim guard disagrees: %', v_drift;
  END IF;
END
$post$;
