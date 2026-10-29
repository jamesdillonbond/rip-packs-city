-- STAGED, NOT APPLIED (2026-10-29, Claude Code cloud, session_014vX7Q7qM7twrBUY9w4M9yP).
-- The apply_migration call raised a Supabase MCP approval prompt that never reached the client, so it
-- timed out. To apply: paste into the Supabase SQL editor (or approve it from an MCP client that shows
-- the prompt), then commit this file as supabase/migrations/<version>_audit_20261029_sentinel_candy_recorded_silence_is_not_an_ingest_alarm.sql
-- with the version from supabase_migrations.schema_migrations.
--
-- WHY. Sentinel warns every hour, on two arms, about Candy MLB having no sales:
--   * "Sales Ingest by Collection": ⚠️Candy MLB 0/24h (last ~423h ago >12h!)
--   * "Zero-Yield Lanes": candy-sales-indexer (60 runs, last find 2026-10-12)
-- Both restate a RECORDED fact, not a fault: v_collection_marketplace_status.candy_mlb.secondary_status
-- = 'silent_since_2026_10_11' (#58, settled by a Solana collection census, 10-25), the indexer runs ok
-- with 0 unresolved, and v_rpc_trust_health.candy_revival_sales_since_recorded_silence already pages on
-- the FIRST new sale. A warn that cannot be acted on trains the reader to skip the sentinel line.
-- Since 2c68997cf the "off" label reads "(silent by decision)" for a market that is not closed, so this
-- change cannot make Candy read "market closed".
--
-- WHAT CHANGES: (1) sentinel_ingest_watch candy_mlb loudness 'warn' -> 'off', with a note naming the
-- record and the revival arm. (2) a pipeline_zero_yield_suppressions row for candy-sales-indexer with a
-- RE-CHECK CONDITION, in the house format.
-- REVERT: UPDATE sentinel_ingest_watch SET loudness = 'warn', note = 'bursty magic_eden cron; worst
-- normal 14d gap 5.4h' WHERE collection_key = 'candy_mlb'; DELETE FROM pipeline_zero_yield_suppressions
-- WHERE pipeline = 'candy-sales-indexer';

DO $premise$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.v_collection_marketplace_status
                  WHERE slug = 'candy_mlb' AND secondary_status = 'silent_since_2026_10_11') THEN
    RAISE EXCEPTION 'premise: candy_mlb is no longer recorded silent; re-verify before silencing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales
              WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
                AND sold_at > timestamptz '2026-10-12 04:00:00+00') THEN
    RAISE EXCEPTION 'premise: Candy has traded since the recorded silence; update the record instead';
  END IF;
END
$premise$;

UPDATE public.sentinel_ingest_watch
   SET loudness = 'off',
       note = 'RECORDED SILENCE, not an ingest fault (2026-10-29): v_collection_marketplace_status.candy_mlb.secondary_status = silent_since_2026_10_11 (#58). Revival pages via v_rpc_trust_health.candy_revival_sales_since_recorded_silence on the first sale; set loudness back to warn then.'
 WHERE collection_key = 'candy_mlb'
   AND loudness = 'warn';

INSERT INTO public.pipeline_zero_yield_suppressions (pipeline, reason, added_by)
SELECT 'candy-sales-indexer',
       'RECORDED SILENCE, measured 2026-10-29 ~9:40 AM PT. Candy secondary trading stopped on 2026-10-11 (#58, Solana collection census 10-25); v_collection_marketplace_status.candy_mlb.secondary_status = silent_since_2026_10_11. The indexer runs ok with 0 unresolved, so "found nothing" is the market, not the lane. RE-CHECK CONDITION: remove this row when candy_revival_sales_since_recorded_silence > 0 (Candy traded again), when secondary_status changes, or if the indexer stops logging ok runs.',
       'claude-code-cloud session_014vX7Q7qM7twrBUY9w4M9yP'
 WHERE NOT EXISTS (SELECT 1 FROM public.pipeline_zero_yield_suppressions WHERE pipeline = 'candy-sales-indexer');
