-- audit_20261110: RECORD-ONLY. Two small indexes built with CREATE INDEX CONCURRENTLY from one-off pg_cron jobs
-- 856 / 857 (2026-11-10 ~12:31 PM PT, 45 s each, both valid; jobs unscheduled, 0 zz-* left; default 120 s timeout,
-- no role change). In prod this file is a no-op that asserts both are valid.
--
-- Why: get_edition_market_bundle runs on every edition page (1.38M calls since 08-12, ~5k buffers each — the
-- estate's highest-volume public read). Two of its sub-reads scanned whole sets on every view:
--   1. The Top Shot active-listings freshness gate `(SELECT max(ingested_at) FROM ts_listings)` sequentially
--      scanned all ~47k rows: 2,991 buffers per call. With (ingested_at): 4 buffers (index-only, backward).
--      get_collection_stats reads the same max. Cost: ts_listings updates that touch ingested_at stop being HOT
--      (~1M HOT of 2.06M updates since 08-12, ~11k/day) on a 40 MB table — against ~45M buffers/day saved.
--   2. get_edition_subedition_siblings matches `split_part(e.external_id, '::', 1) = <base>` over the ~15k Top
--      Shot editions. A partial expression index (Top Shot only, the function's literal predicate) makes it a
--      3-buffer index scan (measured inline: 9 buffers including the latest-FMV lateral).
-- Measured on 124:5108: bundle 7,331 -> 4,377 buffers in a fresh session (the remainder is mostly first-call
-- planning, which pooled PostgREST connections do not repeat).
--
-- Revert (one-off pg_cron job or the SQL editor, one statement each):
--   DROP INDEX CONCURRENTLY public.idx_ts_listings_ingested_at;
--   DROP INDEX CONCURRENTLY public.idx_editions_ts_base_external_id;

CREATE INDEX IF NOT EXISTS idx_ts_listings_ingested_at ON public.ts_listings USING btree (ingested_at);
CREATE INDEX IF NOT EXISTS idx_editions_ts_base_external_id ON public.editions USING btree (split_part((external_id)::text, '::'::text, 1)) WHERE (collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid);
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname IN ('idx_ts_listings_ingested_at', 'idx_editions_ts_base_external_id') AND i.indisvalid AND i.indisready;
  IF n <> 2 THEN
    RAISE EXCEPTION 'edition-page bundle indexes: expected 2 valid, found %', n;
  END IF;
END $$;
