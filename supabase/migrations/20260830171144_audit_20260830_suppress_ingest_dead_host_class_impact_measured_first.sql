-- audit_20260830_suppress_ingest_dead_host_class_impact_measured_first
--
-- Adds ONE bounded row to pipeline_alert_suppression. No schema change, no
-- function change, no other row. Expiry matches the existing "dead host
-- 2026-08-30" class exactly (2026-09-13 00:00Z) so the whole class lapses and
-- gets re-checked together.
--
-- WHY. `ingest` (the Top Shot sales GQL walk) fails with
-- "Top Shot GraphQL failed with 530" -- public-api.nbatopshot.com, the same dead
-- host as the eight pipelines suppressed at 15:55Z today. It was missed then for
-- a reason worth recording: NOTHING WAS ALERTING ON IT. Both silence arms read
-- max(started_at) with no ok filter, so its own failure rows held them green. It
-- only became visible via check_pipelines_running_but_not_succeeding()
-- (migration 20260830165431), which found it had not succeeded in 7 days.
--
-- IMPACT MEASURED BEFORE SUPPRESSING -- suppressing an unmeasured signal is how a
-- real outage gets filed as noise:
--   * topshot_gql supplied ~1,300-1,550 sales/day (~30-35% of TS volume) before
--     the host died: 1,321 -> 557 -> 100 -> 50 -> 0.
--   * BUT on 2026-08-24, with both sources healthy, 1,280 of 1,283 topshot_gql
--     sales (99.8%) ALREADY had a non-GQL counterpart for the same nft_id within
--     +/-10 min. Only 3 were unique to GQL.
--   * NEGATIVE CONTROL: the same query with a deliberately corrupted join key
--     (nft_id || '9') returned 0 matches, so the 99.8% is not an artefact of a
--     too-loose match.
--   => Real loss is ~3 sales/day (~0.2%); the on-chain indexer covers the rest,
--      and it is gap-free (each cursor_before = previous cursor_after).
--
-- EXIT CONDITION: the arm re-fires the moment this lapses on 2026-09-13. If the
-- host is still dead then, RETIRE the ingest step in rpc-pipeline.yml rather than
-- suppressing a third time -- a twice-renewed suppression is a decision nobody is
-- making.
--
-- REVERT:
--   DELETE FROM public.pipeline_alert_suppression WHERE pipeline = 'ingest';

DO $mig$
DECLARE
  v_n int;
BEGIN
  SET LOCAL lock_timeout = '5s';

  IF EXISTS (SELECT 1 FROM public.pipeline_alert_suppression WHERE pipeline = 'ingest') THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: a suppression row for ingest already exists -- re-read before inserting';
  END IF;

  INSERT INTO public.pipeline_alert_suppression (pipeline, reason, added_at, expires_at)
  VALUES (
    'ingest',
    'dead host 2026-08-30: Top Shot sales GQL walk fails "Top Shot GraphQL failed with 530" (public-api.nbatopshot.com) -- SAME class as the eight suppressed at 15:55Z, missed then only because NOTHING was alerting on it (both silence arms read max(started_at) with no ok filter, so its failure rows held them green). Surfaced by check_pipelines_running_but_not_succeeding() (20260830165431): no success in 7 days. IMPACT MEASURED FIRST and it is small -- on 2026-08-24 with both sources healthy, 1,280 of 1,283 topshot_gql sales (99.8%) already had a non-GQL counterpart for the same nft_id within +/-10 min; only 3 unique, so ~3 sales/day (~0.2%). Corrupted-key control (nft_id || 9) returned 0, so that is not a loose join. On-chain indexer is gap-free and covers the rest. EXIT: the arm re-fires when this lapses 2026-09-13; if the host is still dead, RETIRE the ingest step in rpc-pipeline.yml rather than suppress a third time. REVERT: DELETE FROM public.pipeline_alert_suppression WHERE pipeline = ''ingest''.',
    now(),
    '2026-09-13 00:00:00+00'::timestamptz
  );

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: inserted % rows, expected exactly 1', v_n;
  END IF;
END $mig$;
