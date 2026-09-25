-- 2026-09-25 (PT). silent_indexer_failures.unmapped_written_24h counted
-- unmapped_sales rows by INGESTED_at only, so a HISTORY BACKFILL writing old sales
-- flipped a quiet lane to status 'resolving_editions', and get_pipeline_alerts_core
-- published "golazos_sales: Indexer capturing events to unmapped_sales (20 in 24h).
-- Edition-resolution bridge pending." The 20 rows were golazos_v1_history backfill
-- rows SOLD 2026-01-17 (ingested 09-24 4:34 PM – 7:34 PM PT); the live indexer had
-- found 0 events.
--
-- Independent on-chain check the same day (Flow REST, every block from the last
-- recorded Golazos sale at 164,336,360 to the head, 5,624 windows, 0 failed): exactly
-- two txs emit A.87ca73a41bb50ad5.Golazos.Withdraw — the recorded 09-12 sale and a
-- 09-14 PackNFT.Opened. Positive control: the same query finds the Withdraw at two
-- known 09-12 sale blocks. So the lane's zero is the chain's zero, and the alert was
-- describing a backfill as live capture.
--
-- Fix: a row counts only when it was ingested AND sold in the last 24 h — a live
-- capture always is; a backfill of old sales never is. Guarded splice of the live
-- definition (asserts the predicate occurs exactly once), security_invoker restored
-- (CREATE OR REPLACE VIEW resets reloptions), cursor_stall_threshold() call kept
-- (check_cursor_stall_threshold_drift reads this view's definition).
-- Revert: the same splice with the sold_at conjunct removed.

DO $mig$
DECLARE
  v_def text := pg_get_viewdef('public.silent_indexer_failures'::regclass, true);
  v_old text := 'WHERE u.collection_id = pc.cid AND u.ingested_at > (now() - ''24:00:00''::interval)) AS unmapped_written_24h';
  v_new text := 'WHERE u.collection_id = pc.cid AND u.ingested_at > (now() - ''24:00:00''::interval) AND u.sold_at > (now() - ''24:00:00''::interval)) AS unmapped_written_24h';
  v_n int;
BEGIN
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected the unmapped_written_24h predicate exactly once, found % — nothing changed', v_n;
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.silent_indexer_failures AS ' || replace(v_def, v_old, v_new);
  EXECUTE 'ALTER VIEW public.silent_indexer_failures SET (security_invoker = true)';

  v_def := pg_get_viewdef('public.silent_indexer_failures'::regclass, true);
  IF position('u.sold_at > (now() - ''24:00:00''::interval)' IN v_def) = 0 THEN
    RAISE EXCEPTION 'splice did not land';
  END IF;
  IF position('cursor_stall_threshold()' IN v_def) = 0 THEN
    RAISE EXCEPTION 'cursor_stall_threshold() call lost';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.silent_indexer_failures'::regclass AND reloptions @> ARRAY['security_invoker=true']) THEN
    RAISE EXCEPTION 'security_invoker not restored';
  END IF;
END
$mig$;
