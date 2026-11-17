-- Purpose: get_allday_unresolved_pulls() had NO usable index for its
--   "newest AllDay pack_rips first" ordering, so its plan was a double parallel
--   seq scan (pack_rips 1.65M AllDay rows + allday_pack_pull) hash-joined and
--   then fully sorted (~497k rows) to return LIMIT 300.
--   Measured 2026-08-13 over a 39.7h pg_stat_statements window:
--     43 calls, 41.3 GB shared_blks_read, 0.5% buffer hit ratio, 984 MB/call,
--     11.2 s mean  => ~25 GB/day of cold disk reads, ~2.8% of ALL disk reads
--     on an instance whose dominant failure mode is disk-IO throttling.
--   This IS a plan defect (no index can serve the ORDER BY), NOT the
--   "already-optimal plan under throttling" class recorded on 2026-08-12 for
--   sales_2026 -- do not conflate the two.
--
-- Caller: pg_cron jobid 22 rpc-allday-resolve-pull-editions (9,39 * * * *)
--   -> edge fn resolve-allday-pull-editions -> get_allday_unresolved_pulls(int).
--
-- Also drops an INVALID leftover of the same name: a CREATE INDEX CONCURRENTLY
-- attempted earlier this session through the Supabase MCP was cut off by the
-- tool's 60 s client cap and left indisready=true / indisvalid=false.
--
-- Revert: DROP INDEX IF EXISTS public.idx_pack_rips_collection_block_height;

DROP INDEX IF EXISTS public.idx_pack_rips_collection_block_height;

CREATE INDEX idx_pack_rips_collection_block_height
  ON public.pack_rips USING btree (collection_id, block_height DESC)
  WHERE block_height IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
    WHERE i.relname = 'idx_pack_rips_collection_block_height' AND x.indisvalid
  ) THEN
    RAISE EXCEPTION 'idx_pack_rips_collection_block_height missing or invalid after build';
  END IF;
END $$;
