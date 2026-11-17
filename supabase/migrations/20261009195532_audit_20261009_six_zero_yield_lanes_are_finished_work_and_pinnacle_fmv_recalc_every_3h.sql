-- audit_20261009_six_zero_yield_lanes_are_finished_work_and_pinnacle_fmv_recalc_every_3h
--
-- check_zero_yield_lanes() flagged six lanes on 2026-10-09 (it read [] on 10-05). Each one was
-- re-derived live at ~1:00 PM PT 10-09, and every one is FINISHED WORK, not a stall:
--
--   ingest-pinnacle-mints-backfill  every run: "reached spork floor — pre-spork mints need the spork
--                                    worker" (spork_floor 137390146). 720 edge-function calls/day for 0
--                                    rows since 09-29. The forward lane (rpc-pinnacle-mints-forward, same
--                                    edge fn) is live and wrote rows today.
--   pinnacle-pull-chain             queue fully drained 09-30 (54,022 + 1,313 read, 11 failed, 0 pending).
--                                    Positive control: 0 enqueue candidates now, and all 414 pulls of the
--                                    10-09 drop (dist 8891) already carry a pinnacle_mint_events row, so
--                                    new opens never need this lane. It still ran every minute holding a
--                                    worker for its 15 s sleep.
--   golazos-sales-history-backfill  parked at the spork floor (extra.note = reached_spork_floor_hint), the
--                                    same reading as the 09-19 pinnacle-sales-history-backfill suppression.
--   pack-index-mints                pack_index_mint_state.last_scan_todo = 0 (scanned 10-09 16:37Z).
--   topshot-wmc-null-key-heal       0 Top Shot wallet_moments_cache rows with edition_key NULL (waiting 0).
--   wmc-edition-key-reconcile       extra.no_op = true, window 0, 47 ms a run.
--
-- What this migration does:
--   (1) rpc-pinnacle-mints-backfill (jobid 84) deactivated. check_edge_lane_observability joins on
--       cron.job.active, so an inactive lane is not reported stale.
--   (2) rpc-pinnacle-pull-chain-lane keeps its every-minute slot but sleeps and runs ONLY when the
--       queue holds work, or on the 10-minute enqueue tick (the chain-arrival "sleep only when there is
--       work" pattern, 20261002155614; one EXPLAIN shows a One-Time Filter ahead of the pg_sleep, and the
--       two EXISTS each hit an existing partial index). Throughput on a new backlog is unchanged; idle cost drops 10x.
--   (3) rpc-pinnacle-fmv-recalc-backstop (jobid 200) 37 22 * * * -> 37 1-22/3 * * *. Found the same
--       hour: the 10-09 Star Wars drop (dist 8891, 414 opens 9:00-9:40 AM PT) put 5 brand-new renders on
--       the market with 5-13 sales and 8-18 listings each by midday, but their catalog FMV stayed
--       NO_DATA because the last full recalc ran at 3:07 AM PT and the next was 3:37 PM PT, so every
--       pull of the drop read unpriced for ~6.5 h. A drop's first hours are when pull values matter most.
--       The full recalc (not an incremental one) is used on purpose: pinnacle_fmv_stale_hours and the
--       overview "12-HOURLY" badge both read max(fmv_computed_at), so a second, narrower writer would
--       keep that stamp fresh while the full recompute was dead. Cost: ~820k buffers and 5-25 s a run,
--       +6 runs/day, roughly offset by (2).
--   (4) Six suppression rows, each with a RE-CHECK CONDITION.
--
-- REVERT:
--   SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname='rpc-pinnacle-mints-backfill'), active := true);
--   SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname='rpc-pinnacle-pull-chain-lane'),
--          command := 'SELECT public.run_pinnacle_pull_chain_lane() FROM pg_sleep(15);');
--   SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname='rpc-pinnacle-fmv-recalc-backstop'), schedule := '37 22 * * *');
--   DELETE FROM public.pipeline_zero_yield_suppressions WHERE pipeline IN
--     ('ingest-pinnacle-mints-backfill','pinnacle-pull-chain','golazos-sales-history-backfill',
--      'pack-index-mints','topshot-wmc-null-key-heal','wmc-edition-key-reconcile');

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM cron.job
   WHERE jobname IN ('rpc-pinnacle-mints-backfill','rpc-pinnacle-pull-chain-lane','rpc-pinnacle-fmv-recalc-backstop');
  IF v_n <> 3 THEN RAISE EXCEPTION 'expected 3 cron jobs, found %', v_n; END IF;

  PERFORM cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rpc-pinnacle-mints-backfill'), active := false);

  PERFORM cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rpc-pinnacle-pull-chain-lane'),
    command := 'SELECT public.run_pinnacle_pull_chain_lane() FROM pg_sleep(15) WHERE EXISTS (SELECT 1 FROM public.pinnacle_pull_chain_pins WHERE status = ''pending'') OR EXISTS (SELECT 1 FROM public.pinnacle_pull_chain_pins WHERE status = ''in_flight'') OR extract(minute FROM now())::int % 10 = 0;');

  PERFORM cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rpc-pinnacle-fmv-recalc-backstop'),
    schedule := '37 1-22/3 * * *');
END $$;

INSERT INTO public.pipeline_zero_yield_suppressions (pipeline, reason, added_by) VALUES
('ingest-pinnacle-mints-backfill',
 'FINISHED + DEACTIVATED, measured 2026-10-09 ~1:00pm PT. Every run since 09-29 returned "reached spork floor - pre-spork mints need the spork worker" (spork_floor 137390146), 0 rows, 720 edge calls/day; jobid 84 rpc-pinnacle-mints-backfill deactivated in this migration. The forward lane is live (ingest-pinnacle-mints-forward wrote rows 10-09) and all 414 pulls of the 10-09 drop carry a mint event. RE-CHECK CONDITION: remove this row if the job is re-activated, or if a spork-proxy worker for pre-137390146 mints is built.',
 'claude-code-cloud session_01V7wSyjqNm8RwtFjxMMGUDR'),
('pinnacle-pull-chain',
 'DRAINED QUEUE, measured 2026-10-09 ~1:00pm PT. pinnacle_pull_chain_pins: 54,022 read (stage 1) + 1,313 read (stage 2) + 11 failed, 0 pending/in_flight, last finish 09-30. Positive control: the lane''s own enqueue predicate selects 0 candidates, and 414 of 414 pulls of the 10-09 Star Wars drop already have a pinnacle_mint_events row, so new opens are named without this lane. RE-CHECK CONDITION: remove this row if the enqueue predicate selects candidates again (pulls with no mint event) or if pinnacle_mint_events coverage of new opens drops below 100%.',
 'claude-code-cloud session_01V7wSyjqNm8RwtFjxMMGUDR'),
('golazos-sales-history-backfill',
 'CORRECT ZERO, measured 2026-10-09 ~1:00pm PT. Parked at the spork floor by design: every run returns extra.note = reached_spork_floor_hint, extra.next = "deeper history (<2025-12-29) needs spork-proxy" - the same reading as the 09-19 pinnacle-sales-history-backfill row. 8 runs/day, ~250 ms each. RE-CHECK CONDITION: remove this row if a spork-proxy reader is built, or if extra.note changes.',
 'claude-code-cloud session_01V7wSyjqNm8RwtFjxMMGUDR'),
('pack-index-mints',
 'DRAINED, measured 2026-10-09 ~1:00pm PT. pack_index_mint_state.last_scan_todo = 0 at the 16:37Z scan; runs report scanned=false, dispatched 0, failed 0. Last find 10-01 (114 written). RE-CHECK CONDITION: remove this row if last_scan_todo goes non-zero while rows_found stays 0, or if failed/expired go non-zero.',
 'claude-code-cloud session_01V7wSyjqNm8RwtFjxMMGUDR'),
('topshot-wmc-null-key-heal',
 'DRAINED, measured 2026-10-09 ~1:00pm PT. 0 Top Shot wallet_moments_cache rows with edition_key IS NULL (the lane''s whole population; extra.waiting = 0). RE-CHECK CONDITION: remove this row if extra.waiting > 0 for more than a day while filled stays 0.',
 'claude-code-cloud session_01V7wSyjqNm8RwtFjxMMGUDR'),
('wmc-edition-key-reconcile',
 'DRAINED, measured 2026-10-09 ~1:00pm PT. Every run reports extra.no_op = true, window 0, ~50 ms; last find 09-30. RE-CHECK CONDITION: remove this row if extra.window > 0 for more than a day while filled stays 0.',
 'claude-code-cloud session_01V7wSyjqNm8RwtFjxMMGUDR');

DO $$
BEGIN
  IF (SELECT active FROM cron.job WHERE jobname = 'rpc-pinnacle-mints-backfill') THEN
    RAISE EXCEPTION 'rpc-pinnacle-mints-backfill still active';
  END IF;
  IF (SELECT schedule FROM cron.job WHERE jobname = 'rpc-pinnacle-fmv-recalc-backstop') <> '37 1-22/3 * * *' THEN
    RAISE EXCEPTION 'fmv recalc schedule not applied';
  END IF;
  IF (SELECT command FROM cron.job WHERE jobname = 'rpc-pinnacle-pull-chain-lane') NOT LIKE '%WHERE EXISTS (SELECT 1 FROM public.pinnacle_pull_chain_pins%' THEN
    RAISE EXCEPTION 'pull-chain gate not applied';
  END IF;
  IF (SELECT count(*) FROM public.pipeline_zero_yield_suppressions WHERE pipeline IN
      ('ingest-pinnacle-mints-backfill','pinnacle-pull-chain','golazos-sales-history-backfill',
       'pack-index-mints','topshot-wmc-null-key-heal','wmc-edition-key-reconcile')) <> 6 THEN
    RAISE EXCEPTION 'suppressions not written';
  END IF;
END $$;
