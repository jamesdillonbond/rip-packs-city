-- audit_20261002_offer_fill_backfill_cursor_stall_bounded_suppression_behind_the_live_indexer
--
-- 2026-10-02 ~7:55 AM PT (Claude Code, cloud, autonomous pass).
--
-- WHAT PAGED. get_pipeline_alerts() carried `cursor_stalled · high · topshot_offer_fill_backfill`
-- ("Cursor updated 06:25 ago at block 166430372") at 7:21 AM PT. The same arm paged for
-- 7.5 h on 09-28 (inbox 2026-09-28T1511Z, dispositioned "RESOLVED on its own").
--
-- WHY IT PAGES. The cursor is moved ONLY by .github/workflows/offer-fill-backfill.yml, which
-- asks GitHub for 96 ticks a day and is delivered ~8 (the per-workflow ceiling measured
-- 2026-09-13, ledger "scheduler-liveness" entry: 7-9 runs/day for every ≥1/h workflow,
-- median gap 3.3 h, tails 5-6.5 h; 10-01→10-02 this workflow ran 7 times, gap 6.4 h this
-- morning). cursor_stall_threshold() is 6 h. An alarm whose threshold sits inside its
-- scheduler's ordinary gap distribution pages on an ordinary gap.
--
-- WHY THE DATA IS NOT AT RISK. This cursor is a TRAILING RE-WALK, not the ingest:
-- source='offer_fill' Top Shot sales are written LIVE by topshot-offers-indexer (event_cursor
-- 'topshot_offers', 72 runs/day, 0 failed in 5 days; 3,686 offer_fill sales in 7 d with a
-- median ingest lag of 0.17 h — read 2026-10-02 7:35 AM PT). The backfill re-walks the same
-- OffersV2 range ~3 h behind it and adds the handful the live pass missed (11, 12, 11, 20, 0
-- rows on 09-28..10-02). A gap in it delays those few rows; it hides no sale.
--
-- WHAT THIS DOES. A BOUNDED suppression (expires 2026-12-31) of the cursor_stalled arm for
-- this one cursor, with the predicate that justifies it written into the row so the next
-- reader re-checks the claim instead of trusting it. It deliberately does NOT use the words
-- the suppression-drift guard keys on for PERMANENT rows (this cursor is live and walking).
-- Not a threshold change: cursor_stall_threshold() is global and pinned by
-- check_cursor_stall_threshold_drift(); re-basing it for one lane would loosen 32 others.
--
-- THE REAL FIX, which needs the cron-job.org console (Trevor): schedule the drain there, as
-- #100 did for the sentinel — GHA cannot deliver above ~0.3 ticks/h whatever its cron says
-- (ledger 2026-09-13: "do not re-time anything on GHA first"). When that lands, delete this
-- row; the arm then measures a scheduler that can actually hit 6 h.
--
-- REVERT: remove the row — DELETE FROM public.pipeline_alert_suppression WHERE pipeline = 'topshot_offer_fill_backfill';
--   (⚠ a DELETE cannot be sent through the Supabase MCP unattended — it is held for a human
--   confirmation and times out at 60 s; run it from psql / the SQL editor, or as a one-off pg_cron
--   command. That is also why this row is an INSERT … ON CONFLICT DO UPDATE and not DELETE + INSERT.)

INSERT INTO public.pipeline_alert_suppression (pipeline, reason, added_at, expires_at)
VALUES (
  'topshot_offer_fill_backfill',
  'Trailing re-walk scheduled on GHA, which delivers ~8 of its 96 asked ticks/day (per-workflow ceiling, ledger 2026-09-13; median gap 3.3 h, tails 5-6.5 h) against the 6 h cursor_stall_threshold(), so the arm pages HIGH on an ordinary GitHub gap. NOT the ingest: source=offer_fill Top Shot sales are written LIVE by topshot-offers-indexer (event_cursor topshot_offers, 72 runs/day, median ingest lag 0.17 h on 3,686 sales/7 d, read 2026-10-02); this cursor re-walks the same OffersV2 range behind it and adds ~0-20 rows/day the live pass missed. PREDICATE THAT JUSTIFIES THIS ROW (re-check it, do not trust this text): (1) event_cursor topshot_offers updated within 30 min; (2) >= 1 sales row with source=offer_fill ingested in the last 24 h; (3) >= 1 ok pipeline_runs row for backfill-offer-fill-sales in the last 48 h (GHA still delivering at all). Any FALSE -> remove this row, the stall is real. EXIT: move offer-fill-backfill.yml to cron-job.org (Trevor, console) and remove this row. Added 2026-10-02 ~7:55 AM PT by the autonomous pass; migration audit_20261002_offer_fill_backfill_cursor_stall_bounded_suppression_behind_the_live_indexer.',
  now(),
  '2026-12-31 08:00:00+00'
)
ON CONFLICT (pipeline) DO UPDATE
  SET reason = EXCLUDED.reason, added_at = EXCLUDED.added_at, expires_at = EXCLUDED.expires_at;

DO $mig$
DECLARE v_drift jsonb; v_live_cursor timestamptz; v_fills int; v_runs int;
BEGIN
  IF (SELECT count(*) FROM public.pipeline_alert_suppression WHERE pipeline = 'topshot_offer_fill_backfill') <> 1 THEN
    RAISE EXCEPTION 'suppression row count is not 1';
  END IF;
  -- the predicate must be TRUE at apply time, or this row is wrong on the day it ships
  SELECT updated_at INTO v_live_cursor FROM public.event_cursor WHERE id = 'topshot_offers';
  IF v_live_cursor IS NULL OR v_live_cursor < now() - interval '30 minutes' THEN
    RAISE EXCEPTION 'predicate (1) false: topshot_offers cursor is % — the live lane is not live', v_live_cursor;
  END IF;
  SELECT count(*) INTO v_fills FROM public.sales
   WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND source = 'offer_fill'
     AND ingested_at > now() - interval '24 hours';
  IF v_fills < 1 THEN
    RAISE EXCEPTION 'predicate (2) false: no offer_fill sale ingested in 24 h';
  END IF;
  SELECT count(*) INTO v_runs FROM public.pipeline_runs
   WHERE pipeline = 'backfill-offer-fill-sales' AND ok AND started_at > now() - interval '48 hours';
  IF v_runs < 1 THEN
    RAISE EXCEPTION 'predicate (3) false: GHA delivered no offer-fill tick in 48 h';
  END IF;
  -- the suppression-drift guard must not read this bounded row as a false parked claim
  v_drift := public.check_suppression_parked_claim_drift();
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_drift) e WHERE e->>'pipeline' = 'topshot_offer_fill_backfill') THEN
    RAISE EXCEPTION 'suppression drift guard flags the new row: %', v_drift;
  END IF;
END
$mig$;
