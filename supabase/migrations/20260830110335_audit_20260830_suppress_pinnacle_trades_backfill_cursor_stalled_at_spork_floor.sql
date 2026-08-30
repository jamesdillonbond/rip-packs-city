-- audit_20260830_suppress_pinnacle_trades_backfill_cursor_stalled_at_spork_floor
--
-- WHAT: get_pipeline_alerts() began paging `cursor_stalled` (severity HIGH) for event_cursor
-- id 'pinnacle_trades_backfill' at 2026-08-30 ~09:05Z. The pinnacle TRADE history backfill
-- (app/api/cron/pinnacle-trades-indexer/route.ts, ?mode=backfill, shipped 20260822200000)
-- is a FINITE campaign that walks DOWN to SPORK_FLOOR = 137,390,146 and then logs
-- phase='backfill_floor_reached' without touching the cursor. The 08-22 migration deliberately
-- left the backfill lane out of pipeline_cadence_watchlist ("a silence arm would fire when it
-- completes") but did not cover the OTHER arm: get_pipeline_alerts_core()'s cursor_stalled
-- branch keys on event_cursor.id and reads pipeline_alert_suppression. This is the SIXTH twin
-- of pinnacle_sales_backfill (07-16), golazos/ufc_sales_v1_backfill (07-31),
-- topshot_flowty_backfill (08-04) and allday_sales_v1_backfill (08-13) -- the established
-- terminal-backfill mechanism: a permanent suppression row keyed on the cursor id.
--
-- PREDICATE VERIFIED LIVE 2026-08-30 11:0xZ (re-check it, never trust this conclusion):
--   (1) SELECT last_processed_block, updated_at FROM public.event_cursor
--         WHERE id='pinnacle_trades_backfill'  -> 137390146 EXACTLY, updated 03:05:32Z
--   (2) SELECT count(*) FROM public.pipeline_runs WHERE pipeline='pinnacle-trades-indexer'
--         AND extra->>'phase'='backfill_floor_reached'  -> 46 rows since 03:15:25Z, all ok,
--         rows_found=0, blocks_scanned=0, spork_floor=137390146; last productive backfill
--         run 03:05:24Z.
--   (3) forward lane healthy: event_cursor 'pinnacle_trades' = 162,911,672 at 11:00:03Z,
--         forward runs every 10 min ok (phase no_trades / up_to_date), separately watched by
--         pipeline_cadence_watchlist row 'pinnacle-trades-indexer' (60 m, medium) -- unaffected
--         by this cursor-keyed row.
-- PERMANENT (expires_at NULL), matching the five twins: the floor does not move unless deeper
-- Flow history becomes reachable (spork-proxy workstream). If the backfill is ever re-pointed
-- below the floor, remove this row as part of that work.
--
-- NOT touched: the Vercel cron entry for ?mode=backfill (5,15,25,...) still fires every 10 min
-- and returns in ~200 ms doing nothing; removing it is a vercel.json (route-tree) change and
-- Trevor's call.
--
-- REVERT: DELETE FROM public.pipeline_alert_suppression WHERE pipeline = 'pinnacle_trades_backfill';

DO $$
DECLARE v_block bigint;
BEGIN
  SELECT last_processed_block INTO v_block FROM public.event_cursor WHERE id = 'pinnacle_trades_backfill';
  IF v_block IS DISTINCT FROM 137390146 THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: pinnacle_trades_backfill cursor is % not the spork floor 137390146 -- do not suppress a cursor that is not at the floor', v_block;
  END IF;
  IF EXISTS (SELECT 1 FROM public.pipeline_alert_suppression WHERE pipeline = 'pinnacle_trades_backfill') THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: suppression row already exists';
  END IF;
END $$;

INSERT INTO public.pipeline_alert_suppression (pipeline, reason, expires_at)
VALUES (
  'pinnacle_trades_backfill',
  'Parked at spork floor 137390146 (SPORK_FLOOR in app/api/cron/pinnacle-trades-indexer/route.ts) — structurally cannot advance. THE SIXTH TWIN of pinnacle_sales_backfill (2026-07-16), golazos_sales_v1_backfill + ufc_sales_v1_backfill (07-31), topshot_flowty_backfill (08-04) and allday_sales_v1_backfill (08-13): a finite history backfill whose done branch never writes the cursor, so event_cursor.updated_at freezes at completion and cursor_stalled is the TERMINAL STATE, not a fault. The 2026-08-22 migration that seeded this cursor left the backfill lane out of pipeline_cadence_watchlist on purpose but did not cover this cursor-keyed arm. PREDICATE THAT JUSTIFIES THIS ROW (re-check, do not trust the conclusion): (1) SELECT last_processed_block FROM event_cursor WHERE id=''pinnacle_trades_backfill'' must equal 137390146 exactly (verified 2026-08-30 11:0xZ: 137390146, updated 03:05:32Z); (2) pipeline_runs pipeline=''pinnacle-trades-indexer'' with extra->>''phase''=''backfill_floor_reached'' must be accumulating ok rows (46 since 03:15Z, every one rows_found=0, blocks_scanned=0). Do NOT read this as the Pinnacle trade lane being down: the FORWARD cursor pinnacle_trades is separate (162,911,672 at 11:00Z), separately watched by the pipeline_cadence_watchlist row pinnacle-trades-indexer, and the failure_rate arm keys on the hyphenated pipeline name and is unaffected by this underscored cursor-keyed row. PERMANENT: the floor moves only if pre-spork history becomes reachable (spork-proxy); remove this row as part of that work. Revert: DELETE FROM public.pipeline_alert_suppression WHERE pipeline = ''pinnacle_trades_backfill'';',
  NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.pipeline_alert_suppression WHERE pipeline = 'pinnacle_trades_backfill' AND expires_at IS NULL) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: suppression row not present';
  END IF;
END $$;
