-- Bug 3 (supporting): covering index so pack_ev_latest's DISTINCT ON can apply its
-- pack_ev/pack_price/pack_name filter index-only (INCLUDE cols) instead of ~113k heap
-- fetches. Benefits the 8 non-pack_table_rows consumers of pack_ev_latest that were
-- NOT repointed to the matview. Applied in prod via CREATE INDEX CONCURRENTLY (outside
-- a txn); written here as plain CREATE INDEX IF NOT EXISTS for clean archival replay.
CREATE INDEX IF NOT EXISTS idx_pack_ev_history_listing_covering
  ON public.pack_ev_history (pack_listing_id, snapshotted_at DESC)
  INCLUDE (pack_ev, pack_price, pack_name);
